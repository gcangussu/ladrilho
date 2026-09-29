"""The network of [Z11-6], in PyTorch.

A residual MLP with no normalisation layers, so there is no train/eval
difference for the two implementations to disagree about.
"""

import torch
from torch import nn

INPUT = 182
POLICY = 180
VALUE_HIDDEN = 64


class Block(nn.Module):
    def __init__(self, width: int):
        super().__init__()
        self.l1 = nn.Linear(width, width)
        self.l2 = nn.Linear(width, width)

    def forward(self, h):
        return torch.relu(h + self.l2(torch.relu(self.l1(h))))


class Net(nn.Module):
    def __init__(self, width: int, blocks: int):
        super().__init__()
        self.width = width
        self.stem = nn.Linear(INPUT, width)
        self.blocks = nn.ModuleList(Block(width) for _ in range(blocks))
        self.policy = nn.Linear(width, POLICY)
        self.v1 = nn.Linear(width, VALUE_HIDDEN)
        self.v2 = nn.Linear(VALUE_HIDDEN, 1)

    def forward(self, x):
        """Raw logits over all 180 actions, illegal ones included, and the value."""
        h = torch.relu(self.stem(x))
        for b in self.blocks:
            h = b(h)
        logits = self.policy(h)
        value = torch.tanh(self.v2(torch.relu(self.v1(h)))).squeeze(-1)
        return logits, value

    def tensors(self):
        """The tensors in the checkpoint's order ([Z11-11])."""
        out = [self.stem.weight, self.stem.bias]
        for b in self.blocks:
            out += [b.l1.weight, b.l1.bias, b.l2.weight, b.l2.bias]
        out += [self.policy.weight, self.policy.bias, self.v1.weight, self.v1.bias,
                self.v2.weight, self.v2.bias]
        return out
