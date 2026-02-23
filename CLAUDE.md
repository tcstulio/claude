# CLAUDE.md

## Project Overview

This repository contains a **3D interactive bleacher/grandstand visualization** ("Arquibancada 3D") — a single-page HTML application that renders a stepped seating structure around a central square area using Three.js.

The project is written in **Brazilian Portuguese** (pt-BR). Variable names, UI text, labels, and comments should follow that convention.

## Repository Structure

```
.
└── arquibancada.html   # Single-file application (HTML + CSS + JS)
```

This is a **single-file project** — all markup, styling, and logic live in `arquibancada.html`. There is no build system, bundler, or package manager.

## Technology Stack

| Technology | Version | Purpose |
|---|---|---|
| HTML5 | — | Document structure and UI overlays |
| CSS3 | — | Inline `<style>` block for overlay panels |
| Three.js | 0.160.0 | 3D rendering engine (loaded via CDN import map) |
| ES Modules | — | `<script type="module">` with `importmap` for Three.js |
| OrbitControls | 0.160.0 | Camera interaction (rotate, zoom, pan) |

Three.js and its addons are loaded from `cdn.jsdelivr.net` — there are no local dependencies to install.

## Architecture & Key Concepts

### Scene Structure

The visualization models a bleacher/grandstand ("arquibancada") surrounding a 6m × 6m central square:

- **Central area**: A semi-transparent blue plane marking the 6×6m performance space
- **Straight sections**: 4 sides (North/South/East/West), each with 5 stepped levels built from `BoxGeometry`
- **Curved corners**: 4 quarter-circle arcs (NE/NW/SE/SW) connecting adjacent straight sections, built from `ExtrudeGeometry`
- **Railings**: Cylindrical posts and horizontal rails on levels 2–5, with full back railings on the top level

### Physical Dimensions (constants in code)

| Constant | Value | Description |
|---|---|---|
| `SQUARE_SIZE` | 6m | Central square side length |
| `LEVELS` | 5 | Number of step tiers |
| `STEP_HEIGHT` | 0.4m | Vertical rise per level |
| `STEP_DEPTH` | 0.5m | Horizontal depth per step |
| `RAIL_HEIGHT` | 0.9m | Railing height above step surface |

### Materials

- `woodMat` (brown, `#8d6e63`) — Straight section steps ("praticaveis")
- `curveMat` (lighter brown, `#a1887f`) — Curved corner sections (metalon + wood)
- `railMat` (blue-grey, `#78909c`) — Railings/handrails ("corrimao")
- `groundMat` (dark blue, `#2d2d44`) — Ground plane
- `centerMat` (transparent blue, `#64b5f6`) — Central area indicator

### Key Helper Functions

- `createStep(width, depth, height, x, y, z, material)` — Creates a box mesh for a bleacher step
- `createRailPost(x, y, z)` — Creates a vertical cylindrical railing post
- `createRailSegment(x1, y1, z1, x2, y2, z2)` — Creates a horizontal rail between two points
- `createLabel(text, position)` — Creates a canvas-based sprite label for dimensions

## Development Workflow

### Running Locally

No build step is required. Open `arquibancada.html` directly in a browser, or serve it with any static file server:

```bash
# Python
python3 -m http.server 8000

# Node.js (npx)
npx serve .
```

Then navigate to `http://localhost:8000/arquibancada.html`.

**Note**: The file uses ES module imports (`<script type="module">`), which require the page to be served over HTTP(S) — opening the file directly via `file://` may not work in all browsers due to CORS restrictions on module imports.

### Testing

There are no automated tests. Manual verification is done by visually inspecting the 3D scene in a browser:

- Confirm all 4 straight sections render with correct step geometry
- Verify curved corners connect the straight sections smoothly
- Check railings appear on levels 2–5 and the full top-level railing
- Validate dimension labels display correct measurements
- Test orbit controls (drag to rotate, scroll to zoom, shift+drag to pan)

## Coding Conventions

- **Language**: UI text and comments are in Brazilian Portuguese (pt-BR)
- **Single-file architecture**: All code stays in `arquibancada.html` — do not split into separate files unless explicitly requested
- **No build tools**: Dependencies are loaded via CDN import maps, not npm/yarn
- **Three.js patterns**: Scene objects are added directly to the global `scene`; materials are reused across meshes; shadows are enabled on all geometry
- **Inline styles**: CSS is in a `<style>` block in the `<head>`, not in external files
- **Constants at top**: Physical dimensions are defined as named constants before any geometry code
- **Helper functions**: Reusable geometry creation is extracted into helper functions (`createStep`, `createRailPost`, etc.)

## UI Controls

The application provides OrbitControls-based camera interaction:

- **Drag** — Rotate the camera around the scene
- **Scroll** — Zoom in/out
- **Shift + Drag** — Pan the camera

Three overlay panels provide context:

- **Top-left**: Technical specifications
- **Top-right**: Color legend
- **Bottom-center**: Control instructions
