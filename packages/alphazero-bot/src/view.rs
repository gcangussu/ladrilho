//! The boundary: recognising a ply that resolves a round, the pre-deal view
//! the network values it on ([Z11-9]), and the tile census every input the
//! network is given must pass ([Z11-51]).
//!
//! Every field is read through the offsets `azul_engine` exports ([Z11-8]).

use azul_engine::{
    AzulState, ENCODED_SIZE, FACTORY_SIZE, FLOOR_SLOTS, NUM_COLORS, NUM_FACTORIES, NUM_ROWS,
    OFF_BAG, OFF_CENTER, OFF_FACTORIES, OFF_FACTORY_FLAGS, OFF_LID, OFF_MY_FLOOR, OFF_MY_LINES,
    OFF_MY_WALL, OFF_OP_FLOOR, OFF_OP_LINES, OFF_OP_WALL, OFF_TILES_LEFT, Shuffler,
    TILES_PER_COLOR, wall_color_at,
};

/// The scale of the centre's per-colour counts in [0001 E1-53]'s layout.
const CENTER_SCALE: f32 = 10.0;

/// Whether the ply that took `before` to `after` resolved a round
/// ([0001 E1-30] through [0001 E1-37]).
///
/// An ordinary ply only takes tiles: the board shrinks, the round index and
/// the shuffle count stay, and the game goes on. A boundary ply ends the game,
/// or deals a new round — which advances the round index and refills the
/// board. Any one of those signs is enough.
pub fn is_boundary<S: Shuffler>(before: &AzulState<S>, after: &AzulState<S>) -> bool {
    after.is_terminal()
        || after.round_index() != before.round_index()
        || after.shuffles_used() != before.shuffles_used()
        || after.tiles_left() >= before.tiles_left()
}

fn count(v: f32, scale: f32) -> i32 {
    (v * scale).round() as i32
}

/// Per colour, every tile the input accounts for: bag, lid, displays, centre,
/// both players' pattern lines, floors and walls, each read back by undoing
/// its field's scaling and rounding ([Z11-51]).
pub fn input_census(v: &[f32; ENCODED_SIZE]) -> [i32; NUM_COLORS] {
    let mut out = [0i32; NUM_COLORS];
    let scale = TILES_PER_COLOR as f32;
    for c in 0..NUM_COLORS {
        out[c] += count(v[OFF_BAG + c], scale) + count(v[OFF_LID + c], scale);
        out[c] += count(v[OFF_CENTER + c], CENTER_SCALE);
        for f in 0..NUM_FACTORIES {
            out[c] += count(v[OFF_FACTORIES + f * NUM_COLORS + c], FACTORY_SIZE as f32);
        }
        for off in [OFF_MY_FLOOR, OFF_OP_FLOOR] {
            out[c] += count(v[off + c], FLOOR_SLOTS as f32);
        }
    }
    for off in [OFF_MY_LINES, OFF_OP_LINES] {
        for r in 0..NUM_ROWS {
            let base = off + r * 6;
            let n = count(v[base + 5], (r + 1) as f32);
            for c in 0..NUM_COLORS {
                if v[base + c] == 1.0 {
                    out[c] += n;
                }
            }
        }
    }
    for off in [OFF_MY_WALL, OFF_OP_WALL] {
        for i in 0..25 {
            if v[off + i] == 1.0 {
                out[usize::from(wall_color_at((i / 5) as u8, (i % 5) as u8))] += 1;
            }
        }
    }
    out
}

/// Whether `v` accounts for exactly the tiles of `state`'s own census —
/// against the census, not the constant 20, because a posed position may hold
/// fewer ([0001 E1-40]).
pub fn accounts_for<S: Shuffler>(v: &[f32; ENCODED_SIZE], state: &AzulState<S>) -> bool {
    input_census(v) == state.tile_census().map(i32::from)
}

/// The pre-deal view of the boundary ply from `before` to `after` ([Z11-9]):
/// `after` as it stood between scoring and dealing, from the seat that opens
/// the next round.
///
/// Exact because the bag changes only when a deal draws from it: `before`'s
/// bag is the bag the deal started from, and everything else now in the bag,
/// the lid or the displays was in the lid when scoring finished.
///
/// Meaningful only for a non-terminal boundary; `after` must be `before` with
/// one boundary ply applied. The census check below holds exactly then, and a
/// debug build asserts it on every view taken ([Z11-51]).
pub fn pre_deal_view<S: Shuffler>(before: &AzulState<S>, after: &AzulState<S>) -> [f32; ENCODED_SIZE] {
    let prior = before.encode();
    let mut v = after.encode();
    let scale = TILES_PER_COLOR as f64;
    for c in 0..NUM_COLORS {
        let bag_before = count(prior[OFF_BAG + c], TILES_PER_COLOR as f32);
        let mut dealt = 0;
        for f in 0..NUM_FACTORIES {
            dealt += count(v[OFF_FACTORIES + f * NUM_COLORS + c], FACTORY_SIZE as f32);
        }
        let bag_after = count(v[OFF_BAG + c], TILES_PER_COLOR as f32);
        let lid_after = count(v[OFF_LID + c], TILES_PER_COLOR as f32);
        let lid = (bag_after + lid_after + dealt - bag_before).max(0);
        v[OFF_BAG + c] = (f64::from(bag_before) / scale) as f32;
        v[OFF_LID + c] = (f64::from(lid) / scale) as f32;
    }
    for x in &mut v[OFF_FACTORIES..OFF_FACTORY_FLAGS + NUM_FACTORIES] {
        *x = 0.0;
    }
    v[OFF_TILES_LEFT] = 0.0;
    debug_assert!(
        accounts_for(&v, after),
        "a pre-deal view that does not account for every tile: {:?} against {:?}",
        input_census(&v),
        after.tile_census()
    );
    v
}
