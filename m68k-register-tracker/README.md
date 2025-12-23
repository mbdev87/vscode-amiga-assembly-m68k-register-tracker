# M68K Register Tracker

Visual register usage tracking for Motorola 68000 assembly development.

## Features

- **Live CodeLens** above each subroutine showing register usage
- **Color-coded warnings** for register preservation issues
- **Follows M68K calling conventions**: d0-d1/a0-a1 are scratch, d2-d7/a2-a6 must be preserved

## Register Status Indicators

- `D0 D1` - Scratch registers used (normal)
- `✓D2 D3` - Preserved registers properly saved on stack
- `?D4` - Preserved register read but not modified
- `⚠️ D6 (not saved!)` - **ERROR**: Preserved register modified without saving!

## Example

```assembly
; 📋 D0 D1 A0 | ✓D2 D3 | ⚠️ D6 (not saved!)
MyFunction:
    movem.l d2-d3,-(sp)
    move.l  d6,d0          ; ← D6 modified but not saved!
    ...
```

## Installation

1. Copy to `~/.vscode/extensions/`
2. Reload VSCode
3. Open any `.s` or `.asm` file

## Requirements

- VSCode 1.60.0 or higher
- Amiga Assembly extension (prb28.amiga-assembly)
