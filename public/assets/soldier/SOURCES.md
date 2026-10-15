# Soldier surface maps

The three JPEGs in this folder are original 1024 × 1024 maps from **Brown Leather**, created by **Rob Tuytel** and distributed by Poly Haven under **CC0 1.0**.

- Source: https://polyhaven.com/a/brown_leather
- License: https://polyhaven.com/license
- File metadata: https://api.polyhaven.com/files/brown_leather
- Physical tile size reported by the source: 0.4 m × 0.4 m.

`leather-color.jpg` is the source albedo; `leather-normal.jpg` is the OpenGL normal map; `leather-roughness.jpg` is roughness data. The originals were neither resized nor recompressed. `provenance.json` records their original URLs, MD5 values, SHA-256 values and byte sizes. Total shipped payload: 2,052,770 bytes. Downloaded 2026-10-13.

The game desaturates and tints the albedo at runtime for dark brown/black boots, straps and ammunition pouches. The source is a general leather surface, not a scan of a particular historical uniform or item.

Uniform wool reuses the existing CC0 ambientCG Fabric030 maps in `../fabric`; woven webbing reuses the existing CC0 Poly Haven Hessian 380 maps in `../materials/canvas`. The helmet's fine paint stipple is original deterministic procedural texture data in `src/soldierMaterials.ts`; it adds no downloaded artwork. Museum photographs are reference only and are not shipped.
