//! The network ([Z11-6]), its checkpoint format ([Z11-11]), and the parity
//! check every load runs ([Z11-13]).

use azul_engine::{ACTION_SPACE, Action, ENCODED_SIZE};

use crate::parity;

pub const POLICY: usize = ACTION_SPACE;
pub const VALUE_HIDDEN: usize = 64;
/// The widest network the forward pass holds on its stack. A checkpoint wider
/// than this is refused at load, naming the field.
pub const MAX_WIDTH: u32 = 1024;
const MAX_BLOCKS: u32 = 64;

const MAGIC: &[u8; 4] = b"AZ11";
const VERSION: u32 = 1;
const HEADER: usize = 4 + 4 + 5 * 4 + 4;

/// What the search asks for a leaf ([Z11-6]).
///
/// The legal set is a slice rather than the engine's `ActionList`: a boundary
/// is valued on its pre-deal view with no policy wanted, and the only empty
/// `ActionList` there is to hand over is the dealt position's — whose legal
/// set reads the displays [Z11-15] keeps the search from.
pub trait Evaluator: Sync {
    fn evaluate(&self, observation: &[f32; ENCODED_SIZE], legal: &[Action], out: &mut Evaluation);

    /// [Z11-70]: several leaves at once, `out[i]` for `requests[i]`, each
    /// exactly what `evaluate` gives it alone. One at a time unless the
    /// evaluator knows better.
    fn evaluate_batch(&self, requests: &[Request<'_>], out: &mut [Evaluation]) {
        for (&(observation, legal), o) in requests.iter().zip(out) {
            self.evaluate(observation, legal, o);
        }
    }
}

/// One leaf a search waits on: its input and its legal set.
pub type Request<'a> = (&'a [f32; ENCODED_SIZE], &'a [Action]);

/// A borrowed evaluator evaluates, so a wrapper can hold one by reference.
impl<E: Evaluator + ?Sized> Evaluator for &E {
    fn evaluate(&self, observation: &[f32; ENCODED_SIZE], legal: &[Action], out: &mut Evaluation) {
        (**self).evaluate(observation, legal, out);
    }

    fn evaluate_batch(&self, requests: &[Request<'_>], out: &mut [Evaluation]) {
        (**self).evaluate_batch(requests, out);
    }
}

/// A policy over the 180 actions, zero outside the legal set, and a value in
/// `[-1, 1]` from the observed seat's perspective ([Z11-7]).
#[derive(Clone, Debug, PartialEq)]
pub struct Evaluation {
    pub policy: [f32; POLICY],
    pub value: f32,
}

impl Default for Evaluation {
    fn default() -> Self {
        Evaluation { policy: [0.0; POLICY], value: 0.0 }
    }
}

/// Why a checkpoint or parity file was refused.
#[derive(Clone, Debug, PartialEq)]
pub enum LoadError {
    /// The checkpoint's header or length is wrong; `field` names which.
    Checkpoint { field: &'static str, detail: String },
    /// The parity file's own layout is wrong.
    ParityFile { field: &'static str, detail: String },
    /// The parity file was computed on another corpus ([Z11-12]).
    ParityCorpus { expected: String, found: String },
    /// The forward pass disagrees with PyTorch's ([Z11-13]).
    ParityMismatch { entry: usize, output: String, ours: f32, theirs: f32 },
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Checkpoint { field, detail } => write!(f, "checkpoint: {field}: {detail}"),
            LoadError::ParityFile { field, detail } => write!(f, "parity file: {field}: {detail}"),
            LoadError::ParityCorpus { expected, found } => write!(
                f,
                "parity file: computed on another corpus (sha256 {found}), not the one compiled in ({expected})"
            ),
            LoadError::ParityMismatch { entry, output, ours, theirs } => write!(
                f,
                "parity: corpus entry {entry}, {output}: the forward pass gives {ours}, PyTorch gave {theirs}"
            ),
        }
    }
}

impl std::error::Error for LoadError {}

/// Tensor offsets into the flat weight vector, in the file's order.
#[derive(Clone, Debug)]
struct Layout {
    width: usize,
    blocks: usize,
    stem_w: usize,
    stem_b: usize,
    /// Per block: `B1, b1, B2, b2`.
    block: Vec<[usize; 4]>,
    pol_w: usize,
    pol_b: usize,
    v1_w: usize,
    v1_b: usize,
    v2_w: usize,
    v2_b: usize,
    total: usize,
}

impl Layout {
    fn new(width: usize, blocks: usize) -> Layout {
        let mut at = 0;
        let mut take = |n: usize| {
            let o = at;
            at += n;
            o
        };
        let stem_w = take(width * ENCODED_SIZE);
        let stem_b = take(width);
        let block = (0..blocks)
            .map(|_| [take(width * width), take(width), take(width * width), take(width)])
            .collect();
        let pol_w = take(POLICY * width);
        let pol_b = take(POLICY);
        let v1_w = take(VALUE_HIDDEN * width);
        let v1_b = take(VALUE_HIDDEN);
        let v2_w = take(VALUE_HIDDEN);
        let v2_b = take(1);
        Layout { width, blocks, stem_w, stem_b, block, pol_w, pol_b, v1_w, v1_b, v2_w, v2_b, total: at }
    }
}

/// The network of [Z11-6]: immutable after load, shared by reference across
/// threads.
#[derive(Clone, Debug)]
pub struct Network {
    layout: Layout,
    weights: Vec<f32>,
    /// The stem's and every block's two matrices again, transposed (`[in][out]`),
    /// for `linear_columns`: the stem first, then each block's `B1`, `B2`.
    columns: Vec<f32>,
    generation: u32,
}

/// The lanes of a dot product. A fixed number of independent accumulators
/// combined in a fixed order: the order is in the source, so it is the same on
/// every run, and the compiler can vectorise it without reassociating ([Z11-10]).
const LANES: usize = 16;

// The order of every dot product ([Z11-10]): lane `l` sums `w[16j + l] · x[16j + l]`
// over the whole chunks `j`, in ascending `j`; the elements past the last whole
// chunk are summed on their own, in ascending order, from zero; the lanes are
// folded in halves (`acc[i] += acc[i + n]` for n = 8, 4, 2, 1); and the tail is
// added last. `dot` and `linear` compute exactly that, and nothing else.
//
// The accumulation loops live in functions of their own, never inlined. Inlined
// beside the fold, LLVM vectorised the sixteen lanes as eight pairs, two floats
// to an instruction, with or without AVX2; on their own they take whole
// registers. Same arithmetic, same bits: only the instructions differ.

/// The lanes of one row.
#[inline(never)]
fn lanes(w: &[[f32; LANES]], x: &[[f32; LANES]]) -> [f32; LANES] {
    let mut acc = [0f32; LANES];
    for (a, b) in w.iter().zip(x) {
        for l in 0..LANES {
            acc[l] += a[l] * b[l];
        }
    }
    acc
}

/// The lanes of two rows against one input: each row's lanes exactly as
/// `lanes` would sum them, with twice the independent accumulators.
#[inline(never)]
fn lanes2(w0: &[[f32; LANES]], w1: &[[f32; LANES]], x: &[[f32; LANES]]) -> [[f32; LANES]; 2] {
    let mut a0 = [0f32; LANES];
    let mut a1 = [0f32; LANES];
    for ((p, q), b) in w0.iter().zip(w1).zip(x) {
        for l in 0..LANES {
            a0[l] += p[l] * b[l];
        }
        for l in 0..LANES {
            a1[l] += q[l] * b[l];
        }
    }
    [a0, a1]
}

/// The tail, then the fold, then the sum.
fn finish(mut acc: [f32; LANES], wt: &[f32], xt: &[f32]) -> f32 {
    let mut tail = 0f32;
    for (a, b) in wt.iter().zip(xt) {
        tail += a * b;
    }
    let mut n = LANES;
    while n > 1 {
        n /= 2;
        for i in 0..n {
            acc[i] += acc[i + n];
        }
    }
    acc[0] + tail
}

fn dot(w: &[f32], x: &[f32]) -> f32 {
    let (wc, wt) = w.as_chunks::<LANES>();
    let (xc, xt) = x.as_chunks::<LANES>();
    finish(lanes(wc, xc), wt, xt)
}

/// Every action, ascending: the policy head's rows when all are wanted.
const ALL_ACTIONS: [Action; POLICY] = {
    let mut all = [0; POLICY];
    let mut a = 0;
    while a < POLICY {
        all[a] = a as Action;
        a += 1;
    }
    all
};

/// `linear` on the listed rows only, two at a time, the others of `out` left
/// as they were. A row's bits do not depend on its partner ([Z11-71]).
fn linear_rows(w: &[f32], b: &[f32], x: &[f32], out: &mut [f32], rows: &[Action]) {
    let n = x.len();
    let (xc, xt) = x.as_chunks::<LANES>();
    let (pairs, last) = rows.as_chunks::<2>();
    for &[r0, r1] in pairs {
        let (o0, o1) = (usize::from(r0), usize::from(r1));
        let (c0, t0) = w[o0 * n..(o0 + 1) * n].as_chunks::<LANES>();
        let (c1, t1) = w[o1 * n..(o1 + 1) * n].as_chunks::<LANES>();
        let [a0, a1] = lanes2(c0, c1, xc);
        out[o0] = finish(a0, t0, xt) + b[o0];
        out[o1] = finish(a1, t1, xt) + b[o1];
    }
    if let [r] = last {
        let o = usize::from(*r);
        out[o] = dot(&w[o * n..(o + 1) * n], x) + b[o];
    }
}

/// `out = W · x + b`, `W` row-major `[out][in]`, two rows at a time.
fn linear(w: &[f32], b: &[f32], x: &[f32], out: &mut [f32]) {
    let n = x.len();
    let (xc, xt) = x.as_chunks::<LANES>();
    let (pairs, last) = out.as_chunks_mut::<2>();
    let mut o = 0;
    for y in pairs {
        let r0 = &w[o * n..(o + 1) * n];
        let r1 = &w[(o + 1) * n..(o + 2) * n];
        let (c0, t0) = r0.as_chunks::<LANES>();
        let (c1, t1) = r1.as_chunks::<LANES>();
        let [a0, a1] = lanes2(c0, c1, xc);
        y[0] = finish(a0, t0, xt) + b[o];
        y[1] = finish(a1, t1, xt) + b[o + 1];
        o += 2;
    }
    if let [y] = last {
        *y = dot(&w[o * n..(o + 1) * n], x) + b[o];
    }
}

/// How many inputs `forward_batch` takes at once ([Z11-70]).
pub const BATCH: usize = 4;

/// One row against `BATCH` inputs: each input's lanes exactly as `lanes` would
/// sum them. The row is read once for all of them, which is the point: at
/// width 256 the weights outgrow a core's L2, and a forward pass one input at
/// a time waits on memory, not on the adder.
#[inline(never)]
fn lanes_x4(w: &[[f32; LANES]], x: [&[[f32; LANES]]; BATCH]) -> [[f32; LANES]; BATCH] {
    let n = w.len().min(x[0].len()).min(x[1].len()).min(x[2].len()).min(x[3].len());
    let (w, x0, x1, x2, x3) = (&w[..n], &x[0][..n], &x[1][..n], &x[2][..n], &x[3][..n]);
    let mut a0 = [0f32; LANES];
    let mut a1 = [0f32; LANES];
    let mut a2 = [0f32; LANES];
    let mut a3 = [0f32; LANES];
    for j in 0..n {
        let p = &w[j];
        for l in 0..LANES {
            a0[l] += p[l] * x0[j][l];
        }
        for l in 0..LANES {
            a1[l] += p[l] * x1[j][l];
        }
        for l in 0..LANES {
            a2[l] += p[l] * x2[j][l];
        }
        for l in 0..LANES {
            a3[l] += p[l] * x3[j][l];
        }
    }
    [a0, a1, a2, a3]
}

/// `linear` for `BATCH` inputs at once, one row at a time: every output is the
/// bits `linear` gives its input alone.
fn linear_x4(w: &[f32], b: &[f32], x: [&[f32]; BATCH], out: [&mut [f32]; BATCH]) {
    let m = out[0].len();
    linear_x4_rows(w, b, x, out, 0..m);
}

/// `linear_x4` on the listed rows only, the others of `out` left as they were.
fn linear_x4_rows(w: &[f32], b: &[f32], x: [&[f32]; BATCH], out: [&mut [f32]; BATCH], rows: impl IntoIterator<Item = usize>) {
    let n = x[0].len();
    let split = x.map(|v| v.as_chunks::<LANES>());
    let chunks = split.map(|(c, _)| c);
    for o in rows {
        let (c, t) = w[o * n..(o + 1) * n].as_chunks::<LANES>();
        let acc = lanes_x4(c, chunks);
        for k in 0..BATCH {
            out[k][o] = finish(acc[k], t, split[k].1) + b[o];
        }
    }
}

/// Outputs per block of the column form: their accumulators fill eight of the
/// sixteen 128-bit registers wasm has, two of AVX2's. Sixteen measured slower
/// in V8, from more passes over the input list; sixty-four, from spills.
const BLOCK: usize = 32;

/// The inputs `linear_columns` reads, lane by lane: `(j, x[j])` for each
/// non-zero `x[j]` of a whole chunk, lane `l`'s at `list[starts[l]..starts[l + 1]]`
/// in ascending `j`, and the tail's non-zero ones last, from `starts[LANES]`.
struct NonZero<'a> {
    list: &'a [(u32, f32)],
    starts: [usize; LANES + 1],
}

impl<'a> NonZero<'a> {
    fn of(x: &[f32], buf: &'a mut [(u32, f32)]) -> NonZero<'a> {
        let whole = x.len() / LANES * LANES;
        let mut starts = [0; LANES + 1];
        let mut len = 0;
        for l in 0..LANES {
            starts[l] = len;
            for j in (l..whole).step_by(LANES) {
                buf[len] = (j as u32, x[j]);
                len += usize::from(x[j] != 0.0);
            }
        }
        starts[LANES] = len;
        for j in whole..x.len() {
            buf[len] = (j as u32, x[j]);
            len += usize::from(x[j] != 0.0);
        }
        NonZero { list: &buf[..len], starts }
    }
}

/// One lane's sum for `B` outputs: `cols[j][k] · v` added in the list's order.
#[inline(always)]
fn column_sum<const B: usize>(cols: &[[f32; B]], list: &[(u32, f32)]) -> [f32; B] {
    let mut acc = [0f32; B];
    for &(j, v) in list {
        let w = &cols[j as usize];
        for k in 0..B {
            acc[k] += w[k] * v;
        }
    }
    acc
}

/// Every lane's sum for `B` outputs, and the tail's. `cols[j]` holds input
/// `j`'s weights for those outputs.
#[inline(never)]
fn column_lanes<const B: usize>(cols: &[[f32; B]], nz: &NonZero<'_>) -> ([[f32; B]; LANES], [f32; B]) {
    let lanes = std::array::from_fn(|l| column_sum(cols, &nz.list[nz.starts[l]..nz.starts[l + 1]]));
    (lanes, column_sum(cols, &nz.list[nz.starts[LANES]..]))
}

/// The fold, the tail and the bias of `finish` and `linear`, for `B` outputs at once.
fn column_finish<const B: usize>((mut acc, tail): ([[f32; B]; LANES], [f32; B]), b: &[f32], out: &mut [f32]) {
    let mut n = LANES;
    while n > 1 {
        n /= 2;
        for i in 0..n {
            for k in 0..B {
                acc[i][k] += acc[i + n][k];
            }
        }
    }
    for k in 0..B {
        out[k] = (acc[0][k] + tail[k]) + b[k];
    }
}

/// `linear`, from the matrix's columns, reading only the inputs that are not
/// zero: the same bits. Each lane of each output sums its products in the
/// ascending order [Z11-10] gives them, the tail likewise, then the same fold,
/// tail and bias. What it skips adds nothing: a lane starts at `+0` and,
/// rounding to nearest, a sum is `-0` only when both its terms are, so no lane
/// is ever `-0`, and adding the `±0` a zero input makes leaves it exactly as
/// it was. Finite weights are assumed, which the parity check of every load
/// holds them to ([Z11-13]).
///
/// `wt` is `columns_of` the matrix. At width 256 about half the inputs of a
/// hidden layer are zero after the ReLU, and three quarters of the
/// observation's.
fn linear_columns(wt: &[f32], b: &[f32], nz: &NonZero<'_>, n: usize, out: &mut [f32]) {
    let m = out.len();
    let whole = m / BLOCK * BLOCK;
    for o in (0..whole).step_by(BLOCK) {
        let cols = wt[o * n..(o + BLOCK) * n].as_chunks::<BLOCK>().0;
        column_finish(column_lanes(cols, nz), &b[o..o + BLOCK], &mut out[o..o + BLOCK]);
    }
    for o in whole..m {
        let cols = wt[o * n..(o + 1) * n].as_chunks::<1>().0;
        column_finish(column_lanes(cols, nz), &b[o..o + 1], &mut out[o..o + 1]);
    }
}

/// An `rows × cols` row-major matrix as `linear_columns` reads it: each whole
/// block of `BLOCK` rows as `[cols][BLOCK]`, then each row past the last whole
/// block as its own `[cols]`.
fn columns_of(w: &[f32], rows: usize, cols: usize, out: &mut Vec<f32>) {
    let whole = rows / BLOCK * BLOCK;
    for o0 in (0..whole).step_by(BLOCK) {
        for j in 0..cols {
            out.extend((o0..o0 + BLOCK).map(|o| w[o * cols + j]));
        }
    }
    out.extend_from_slice(&w[whole * cols..rows * cols]);
}

fn relu(x: &mut [f32]) {
    for v in x {
        *v = v.max(0.0);
    }
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    let mut w = [0u8; 4];
    w.copy_from_slice(&bytes[at..at + 4]);
    u32::from_le_bytes(w)
}

fn read_f32s(bytes: &[u8]) -> Vec<f32> {
    bytes.as_chunks::<4>().0.iter().map(|w| f32::from_le_bytes(*w)).collect()
}

/// `Network::columns`: the stem's and every block's matrices, `columns_of` each.
fn transposed(l: &Layout, w: &[f32]) -> Vec<f32> {
    let n = l.width;
    let mut out = Vec::with_capacity(n * ENCODED_SIZE + 2 * l.blocks * n * n);
    columns_of(&w[l.stem_w..l.stem_b], n, ENCODED_SIZE, &mut out);
    for &[b1w, b1b, b2w, b2b] in &l.block {
        columns_of(&w[b1w..b1b], n, n, &mut out);
        columns_of(&w[b2w..b2b], n, n, &mut out);
    }
    out
}

fn bad(field: &'static str, detail: impl Into<String>) -> LoadError {
    LoadError::Checkpoint { field, detail: detail.into() }
}

impl Network {
    /// Reads a checkpoint ([Z11-11]) and refuses it unless its forward pass
    /// matches the parity file PyTorch wrote beside it ([Z11-13]).
    pub fn load(checkpoint: &[u8], parity: &[u8]) -> Result<Network, LoadError> {
        let net = Network::read(checkpoint)?;
        let expected = parity::read_parity(parity)?;
        net.check_parity(&expected)?;
        Ok(net)
    }

    /// The checkpoint alone, unchecked. Crate-private: nothing outside may hold
    /// a network that has not passed parity.
    pub(crate) fn read(bytes: &[u8]) -> Result<Network, LoadError> {
        if bytes.len() < HEADER {
            return Err(bad("length", format!("{} bytes, shorter than the {HEADER}-byte header", bytes.len())));
        }
        if &bytes[0..4] != MAGIC {
            return Err(bad("magic", "not AZ11"));
        }
        let version = read_u32(bytes, 4);
        if version != VERSION {
            return Err(bad("version", format!("{version}, not {VERSION}")));
        }
        let input = read_u32(bytes, 8);
        let width = read_u32(bytes, 12);
        let blocks = read_u32(bytes, 16);
        let policy = read_u32(bytes, 20);
        let hidden = read_u32(bytes, 24);
        let generation = read_u32(bytes, 28);
        if input as usize != ENCODED_SIZE {
            return Err(bad("input", format!("{input}, not {ENCODED_SIZE}")));
        }
        if width == 0 || width > MAX_WIDTH {
            return Err(bad("width", format!("{width}, not in 1..={MAX_WIDTH}")));
        }
        if blocks > MAX_BLOCKS {
            return Err(bad("blocks", format!("{blocks}, past {MAX_BLOCKS}")));
        }
        if policy as usize != POLICY {
            return Err(bad("policy", format!("{policy}, not {POLICY}")));
        }
        if hidden as usize != VALUE_HIDDEN {
            return Err(bad("value hidden", format!("{hidden}, not {VALUE_HIDDEN}")));
        }
        let layout = Layout::new(width as usize, blocks as usize);
        let want = HEADER + 4 * layout.total;
        if bytes.len() != want {
            return Err(bad("length", format!("{} bytes, but the header implies {want}", bytes.len())));
        }
        let weights = read_f32s(&bytes[HEADER..]);
        let columns = transposed(&layout, &weights);
        Ok(Network { layout, weights, columns, generation })
    }

    /// `(W, B)`.
    pub fn architecture(&self) -> (u32, u32) {
        (self.layout.width as u32, self.layout.blocks as u32)
    }

    /// The generation that produced it, from its header.
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// Every logit, illegal ones included, and the value. Allocates nothing:
    /// the activations live on the stack ([Z11-10]).
    pub fn forward(&self, x: &[f32; ENCODED_SIZE], logits: &mut [f32; POLICY]) -> f32 {
        self.forward_rows(x, &ALL_ACTIONS, logits)
    }

    /// [Z11-71]: `forward` with only the listed actions' logits computed, the
    /// rest of `logits` left as they were. Each is the bits `forward` gives it.
    fn forward_rows(&self, x: &[f32; ENCODED_SIZE], rows: &[Action], logits: &mut [f32; POLICY]) -> f32 {
        let l = &self.layout;
        let w = &self.weights;
        let n = l.width;
        let c = &self.columns;
        let mut h = [0f32; MAX_WIDTH as usize];
        let mut t = [0f32; MAX_WIDTH as usize];
        let mut u = [0f32; MAX_WIDTH as usize];
        let mut buf = [(0u32, 0f32); MAX_WIDTH as usize];
        let (h, t, u) = (&mut h[..n], &mut t[..n], &mut u[..n]);

        // The stem and the blocks read the matrices' columns ([`linear_columns`]).
        let mut at = 0;
        let mut col = |len: usize| {
            at += len;
            &c[at - len..at]
        };
        linear_columns(col(n * ENCODED_SIZE), &w[l.stem_b..l.stem_b + n], &NonZero::of(x, &mut buf), ENCODED_SIZE, h);
        relu(h);
        for &[_, b1b, _, b2b] in &l.block {
            linear_columns(col(n * n), &w[b1b..b1b + n], &NonZero::of(h, &mut buf), n, t);
            relu(t);
            linear_columns(col(n * n), &w[b2b..b2b + n], &NonZero::of(t, &mut buf), n, u);
            for i in 0..n {
                h[i] = (h[i] + u[i]).max(0.0);
            }
        }
        linear_rows(&w[l.pol_w..l.pol_b], &w[l.pol_b..l.pol_b + POLICY], h, logits, rows);
        let mut v = [0f32; VALUE_HIDDEN];
        linear(&w[l.v1_w..l.v1_b], &w[l.v1_b..l.v1_b + VALUE_HIDDEN], h, &mut v);
        relu(&mut v);
        let out = dot(&w[l.v2_w..l.v2_w + VALUE_HIDDEN], &v) + w[l.v2_b];
        out.tanh()
    }

    /// [Z11-70]: `forward` on `BATCH` inputs at once, each output the bits
    /// `forward` gives that input alone. Allocates nothing either ([Z11-10]).
    pub fn forward_batch(&self, x: [&[f32; ENCODED_SIZE]; BATCH], logits: &mut [[f32; POLICY]; BATCH]) -> [f32; BATCH] {
        self.forward_batch_rows(x, &[true; POLICY], logits)
    }

    /// [Z11-71]: `forward_batch` with only the logits `wanted` marks computed,
    /// for every input, the rest of `logits` left as they were.
    fn forward_batch_rows(
        &self,
        x: [&[f32; ENCODED_SIZE]; BATCH],
        wanted: &[bool; POLICY],
        logits: &mut [[f32; POLICY]; BATCH],
    ) -> [f32; BATCH] {
        let l = &self.layout;
        let w = &self.weights;
        let n = l.width;
        const M: usize = MAX_WIDTH as usize;
        let mut h = [[0f32; M]; BATCH];
        let mut t = [[0f32; M]; BATCH];
        let mut u = [[0f32; M]; BATCH];

        linear_x4(&w[l.stem_w..l.stem_b], &w[l.stem_b..l.stem_b + n], x.map(|v| &v[..]), h.each_mut().map(|r| &mut r[..n]));
        for r in &mut h {
            relu(&mut r[..n]);
        }
        for &[b1w, b1b, b2w, b2b] in &l.block {
            linear_x4(&w[b1w..b1b], &w[b1b..b1b + n], h.each_ref().map(|r| &r[..n]), t.each_mut().map(|r| &mut r[..n]));
            for r in &mut t {
                relu(&mut r[..n]);
            }
            linear_x4(&w[b2w..b2b], &w[b2b..b2b + n], t.each_ref().map(|r| &r[..n]), u.each_mut().map(|r| &mut r[..n]));
            for k in 0..BATCH {
                for i in 0..n {
                    h[k][i] = (h[k][i] + u[k][i]).max(0.0);
                }
            }
        }
        let h = h.each_ref().map(|r| &r[..n]);
        linear_x4_rows(
            &w[l.pol_w..l.pol_b],
            &w[l.pol_b..l.pol_b + POLICY],
            h,
            logits.each_mut().map(|r| &mut r[..]),
            (0..POLICY).filter(|&a| wanted[a]),
        );
        let mut v = [[0f32; VALUE_HIDDEN]; BATCH];
        linear_x4(&w[l.v1_w..l.v1_b], &w[l.v1_b..l.v1_b + VALUE_HIDDEN], h, v.each_mut().map(|r| &mut r[..]));
        for r in &mut v {
            relu(r);
        }
        v.map(|r| (dot(&w[l.v2_w..l.v2_w + VALUE_HIDDEN], &r) + w[l.v2_b]).tanh())
    }

    fn check_parity(&self, expected: &[parity::Expected]) -> Result<(), LoadError> {
        let corpus = parity::corpus();
        let mut logits = [0f32; POLICY];
        for (entry, (obs, want)) in corpus.iter().zip(expected).enumerate() {
            let value = self.forward(&obs.observation, &mut logits);
            let close = |ours: f32, theirs: f32| (ours - theirs).abs() <= 1e-4 * (1.0 + theirs.abs());
            for a in 0..POLICY {
                if !close(logits[a], want.logits[a]) {
                    return Err(LoadError::ParityMismatch {
                        entry,
                        output: format!("logit {a}"),
                        ours: logits[a],
                        theirs: want.logits[a],
                    });
                }
            }
            if !close(value, want.value) {
                return Err(LoadError::ParityMismatch { entry, output: "value".into(), ours: value, theirs: want.value });
            }
        }
        Ok(())
    }
}

/// The policy of [Z11-6] from raw logits: a softmax over the legal set, zero
/// elsewhere. Summed in `f64` in ascending action order.
pub fn masked_softmax(logits: &[f32; POLICY], legal: &[Action], policy: &mut [f32; POLICY]) {
    *policy = [0.0; POLICY];
    let Some(max) = legal.iter().map(|&a| logits[usize::from(a)]).reduce(f32::max) else {
        return;
    };
    let mut sum = 0f64;
    for &a in legal {
        let e = f64::from(logits[usize::from(a)] - max).exp();
        policy[usize::from(a)] = e as f32;
        sum += e;
    }
    for &a in legal {
        policy[usize::from(a)] = (f64::from(policy[usize::from(a)]) / sum) as f32;
    }
}

impl Evaluator for Network {
    /// The legal actions' logits only: the softmax reads no other ([Z11-71]).
    fn evaluate(&self, observation: &[f32; ENCODED_SIZE], legal: &[Action], out: &mut Evaluation) {
        let mut logits = [0f32; POLICY];
        out.value = self.forward_rows(observation, legal, &mut logits);
        masked_softmax(&logits, legal, &mut out.policy);
    }

    /// `BATCH` at a time, each group computing the logits of the actions legal
    /// in any of its requests ([Z11-71]). A short last group of two or more is padded with
    /// its own last request, whose extra answers are dropped: a batch of four
    /// costs less than three passes alone. A last request on its own goes
    /// through `evaluate`.
    fn evaluate_batch(&self, requests: &[Request<'_>], out: &mut [Evaluation]) {
        let n = requests.len().min(out.len());
        let mut logits = [[0f32; POLICY]; BATCH];
        let mut at = 0;
        while at < n {
            let group = (n - at).min(BATCH);
            if group == 1 {
                let (observation, legal) = requests[at];
                self.evaluate(observation, legal, &mut out[at]);
                break;
            }
            let pick = |k: usize| requests[at + k.min(group - 1)];
            let mut wanted = [false; POLICY];
            for &(_, legal) in &requests[at..at + group] {
                for &a in legal {
                    wanted[usize::from(a)] = true;
                }
            }
            let values = self.forward_batch_rows(std::array::from_fn(|k| pick(k).0), &wanted, &mut logits);
            for k in 0..group {
                out[at + k].value = values[k];
                masked_softmax(&logits[k], requests[at + k].1, &mut out[at + k].policy);
            }
            at += group;
        }
    }
}
