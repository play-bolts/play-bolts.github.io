# Imported rifle assets

These three models were obtained through Sketchfab's official Download controls with the user's signed-in account. The Mosin replaces the earlier D_U model with the more detailed independently authored MaX3Dd model. No viewer-cache extraction was used.

| Local file | Original model | Creator | License |
| --- | --- | --- | --- |
| `enfield.glb` | [Lee-Enfield MKIII](https://sketchfab.com/3d-models/lee-enfield-mkiii-f6a2160daf134071a84e3cae5f831875) | Moony_State | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `kar98k.glb` | [Kar98k](https://sketchfab.com/3d-models/kar98k-96b7387fe49b4dd491cc8277f765527a) | Ecler | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `mosin.glb` | [Mosin Nagant M91](https://sketchfab.com/3d-models/mosin-nagant-m91-92ede39f23bd40c7982c727dfd7c4be0) | [MaX3Dd](https://sketchfab.com/MaX3Dd) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

Bolts adaptations: uniform scaling to nominal full-length dimensions (1.132m, 1.110m, and 1.232m respectively), rigid coordinate normalization, independent source bolt geometry, measured muzzle/sight/hand anchors, and removal of display ammunition and the Enfield's bayonet. Static source meshes are grouped by material. The original modeled sights are retained, with the Kar98k rear opening and front blade widened at runtime while preserving their height and optical axis. There is no creator endorsement implied.

Enfield and Kar98k retain their downloaded UVs, source corner normals, and PBR material maps. Color images are encoded as JPEG at quality92, retaining original resolution up to2K. Normal and metallic/roughness images are retained as lossless PNG at up to1K. The geometry is not decimated.

The Mosin retains MaX3Dd's authored wood grain, worn metal, normal maps, roughness/metallic atlas, UVs and corner normals. Its source scope and bayonet are removed for the game's infantry M1891/30 configuration. The source bolt sleeve and round knob are retained; the downward sniper stem is replaced by a straight infantry shank. The stock and wooden handguard are separated by material solely for grip contact checks, with no stock geometry changes. The adapted rifle has 13,026 triangles. Its three 4K PBR images are resampled to2K: opaque base color uses JPEG92, while normals and occlusion/roughness/metallic maps use lossless PNG. The original metallic/roughness values are preserved. The runtime download is approximately7.2MB.

Each `*-provenance.json` records the official source file's SHA256, final GLB SHA256, normalization scale, geometry count, removed components, and verified embedded texture dimensions. Each `*-profile.json` contains the runtime anchor contract. Original download archives remain under `artifacts/sketchfab-source/` and are not served by the web app.

Reproduction uses `scripts/prepare-imported-rifles.py` in Blender with `--background --factory-startup --disable-autoexec`, followed by `scripts/optimize-imported-rifle-textures.py`. The `mosin` choice dispatches to `scripts/prepare-mosin-m91.py`, which can also be run directly. `scripts/convert-sketchfab-weapons.py` produces independent source/final inspection reports and renders.
