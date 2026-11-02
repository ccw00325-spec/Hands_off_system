# CW_Handsoff_sys mascot

Approved by the user on 2026-11-03 (Asia/Seoul): the last, simplified mint character carrying a parcel.

- App/renderer source asset: `src/renderer/assets/mascot.png`.
- Windows icon: `build/app.ico` (16, 24, 32, 48, 64, 128, 256px).
- Generator: built-in ImageGen. The original approved PNG is preserved; ICO generation only resizes and converts its format.
- The parcel represents a task. The character delivers it from the selected control tower to the selected implementation role and brings completion reports back.
- Animation is driven by persisted workflow `dispatch`/`report` events. No simulated AI progress or completion timers are introduced.
- Motion can be turned off, follows reduced-motion preferences, and pauses when the window is hidden.

## Generation prompt

```text
Use case: logo-brand.
Create ONE original, exceptionally simple working AI mascot for CW_Handsoff_sys, an AI task delegation desktop app. This is a new design, not a variation of the earlier detailed robot.
The broad mood is the understated friendliness and tiny readable geometry of modern AI assistant mascots. Do NOT copy any existing company's mascot, logo, crab silhouette or distinctive branding.
Character: one small mint-green chunky squarish creature with slightly stepped corners, no separate head, just TWO small dark square eyes high on its body, two very short simple arms and TWO stubby legs. Its entire body should be understandable as a handful of geometric shapes. No mouth or eyebrows necessary.
Action: the little creature is clearly WALKING TO THE RIGHT WHILE CARRYING A SMALL PARCEL in both arms at waist level. One foot forward, one back. The parcel sits partly in front of its body, leaving both eyes visible. A slight three-quarter view makes the working/carrying action clear. The parcel is warm ivory, a very simple small cuboid with a single dark tape mark, two or three flat faces at most. The character and parcel must feel like a tiny worker carrying a task from a controller to another AI.
Art direction: extremely restrained flat geometric sprite, pixel-adjacent simplicity, crisp chunky edges, solid fills, no outlines except the eyes/tape, maximum four solid colors (mint, slightly deeper mint, warm ivory, charcoal). Clean and charming, not a toy robot rendering. Not glossy, not 3D, no gradients, highlights, shading texture or tiny decoration. No helmet, ears, antenna, screen, mechanical joints, clothing, gloves, fingers, badge, sparks or motion lines.
Composition: one single full-body character and its one small parcel, centered on a square canvas, with comfortable transparent padding, about 70 percent canvas coverage. It should remain legible as a 32px desktop icon and later be easy to animate into idle, carrying and handoff states. Absolutely no second character, alternate poses, icon grid, state sheet, background, floor, shadows, text, letters, caption, frame or watermark.
Background: genuinely transparent alpha.
```

## Simplification edit (approved result)

```text
Edit the most recent mint parcel-carrying mascot into an EXTREMELY SIMPLE FLAT 2D app mascot.
Keep its identity, mint color, two square charcoal eyes, single squarish body with slightly stepped corners, two short legs in a walking pose, two arms holding one small ivory parcel, and transparent background. One character only.
Make one targeted change: REMOVE ALL dimensional rendering and visual detail. The character must look like a tiny flat vector/sprite drawing made from a handful of solid silhouettes, not a rendered 3D sticker.
Specifically: delete the dark mint extrusion/back slab behind its body; delete the visible sole-thickness face under each foot; delete all gradients, highlights, shadows, rounded bevels, surface texture and pale edge halos. Its whole body, both arms, and both legs should be ONE identical solid mint fill, with absolutely no shading between body parts. Two small flat dark square eyes. Keep the parcel as a plain ivory rectangle with a tiny flat sand-colored side face and one simple charcoal tape strip. No outlines or fingers.
Use exactly four solid colors total: mint #9CE4C7, charcoal #202629, warm ivory #F2E7CC, flat sand #D8C9A7. No intermediate tones except clean edge antialiasing.
Preserve the readable carrying/walking action and cheerful understated modern AI-worker personality. This needs the almost typographic simplicity of an assistant mascot: bold silhouette, two eyes, tiny limbs and one box. Entire mascot comfortably inside a square canvas with transparent alpha, no text, logo, frame, floor, extra objects or alternate poses.
```
