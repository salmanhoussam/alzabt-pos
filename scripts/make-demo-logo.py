"""Generates resources/demo/demo-logo.png — the SYNTHETIC logo of the Try Demo shop.

Pure geometry, standard library only (zlib + struct), deterministic: running it again produces the same bytes.
No real brand, no font, no external asset. A 256 x 256 RGBA badge: a teal rounded square, a white ring and a
white check mark ("عالضبط" = "exactly right").

    python scripts/make-demo-logo.py
"""
import math
import struct
import zlib
from pathlib import Path

N = 256
TEAL = (14, 116, 110)
WHITE = (255, 255, 255)
OUT = Path(__file__).resolve().parents[1] / "resources" / "demo" / "demo-logo.png"


def inside_rounded_square(x, y, r=40):
    cx = min(max(x, r), N - 1 - r)
    cy = min(max(y, r), N - 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def pixel(x, y):
    if not inside_rounded_square(x, y):
        return (0, 0, 0, 0)
    d = math.hypot(x - 128, y - 128)
    if 92 <= d <= 104:
        return (*WHITE, 255)
    if min(dist_to_segment(x, y, 82, 132, 116, 166), dist_to_segment(x, y, 116, 166, 178, 96)) <= 11:
        return (*WHITE, 255)
    return (*TEAL, 255)


def png(width, height, rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(png(N, N, [[pixel(x, y) for x in range(N)] for y in range(N)]))
    print(OUT, OUT.stat().st_size, "bytes")
