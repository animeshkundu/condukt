# condukt Design Language Specification v1.0

## Philosophy

Warm, intentional, human. Inspired by Claude.ai's evening-conversation aesthetic — not cold terminal, not generic SaaS. Every surface, every spacing decision, every color choice should feel like it was placed with care.

**Core principles:**
1. **Warm over cold** — brown/charcoal undertones, terracotta accents, never blue-gray
2. **Breathing room** — generous padding, never cramped
3. **Hierarchy through weight** — font weight and size create order, not decoration
4. **Consistency is design** — one value for each concept, used everywhere
5. **Elevation through gradient** — surfaces float via subtle top-to-bottom gradients, not flat colors

---

## 1. Color Palette

### Backgrounds (elevation stack)
| Token | Hex | Use |
|-------|-----|-----|
| `base` | `#1a1815` | Page body, deepest layer |
| `raised` | `#201d18` | Sidebar, footer, secondary panels |
| `surface` | `#2b2a27` | Card backgrounds, form backgrounds |
| `overlay` | `#343230` | Modals, dropdowns, popovers |
| `deep` | `#161411` | Terminal output area |

### Borders
| Token | Hex | Use |
|-------|-----|-----|
| `subtle` | `#302e2b` | Section dividers, panel separators |
| `default` | `#3d3a36` | Card borders, input borders |
| `strong` | `#4a4742` | Hover borders |
| `active` | `#5a5650` | Focus/active borders |

### Text
| Token | Hex | Use |
|-------|-----|-----|
| `primary` | `#e8e6e3` | Headings, body text, primary content |
| `secondary` | `#b1ada1` | Metadata, secondary labels |
| `tertiary` | `#8a8578` | Timestamps, model names, muted info |
| `muted` | `#6b6660` | Section labels, footer text, placeholders |
| `ghost` | `#585350` | Disabled text, empty states |

### Accent
| Token | Hex | Use |
|-------|-----|-----|
| `accent` | `#D97757` | CTA buttons, focus rings, selection indicators, terracotta |
| `accent-hover` | `#C15F3C` | Accent hover state |
| `accent-bg` | `#D9775718` | Accent at 10% opacity for backgrounds |

### Status (semantic)
| Status | Dot/Text | Background |
|--------|----------|------------|
| running | `#60a5fa` | `#1a2a40` |
| completed | `#4ade80` | `#1a3528` |
| failed | `#f87171` | `#3a1a1a` |
| gated | `#fbbf24` | `#352a15` |
| retrying | `#fb923c` | `#3a2515` |
| crashed | `#c084fc` | `#2a1845` |
| pending | `#6b6660` | `#252320` |
| killed | `#6b6660` | `#252320` |

---

## 2. Typography

### Font Stacks
| Use | Stack |
|-----|-------|
| UI (sans) | `Inter, system-ui, -apple-system, sans-serif` |
| Code (mono) | `"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace` |

### Type Scale (5 tiers only)
| Tier | Size | Weight | Tracking | Use |
|------|------|--------|----------|-----|
| **Display** | 28px (mobile) / 32px (desktop) | 700 (bold) | -0.03em | Page titles |
| **Heading** | 15-16px | 600 (semibold) | -0.01em | Card titles, panel headers, node names |
| **Body** | 13-14px | 400 (regular) | normal | Body text, form inputs, descriptions |
| **Small** | 11-12px | 500 (medium) | normal | Metadata, tabs, controls, labels |
| **Micro** | 10px | 600 (semibold) | 0.08em | Badges (uppercase only) |

### Line Heights
| Context | Value |
|---------|-------|
| Display/Heading | 1.1-1.2 |
| Body | 1.5-1.6 |
| Monospace output | 1.5 |
| Labels (uppercase) | 1.0 |

### Letter Spacing
| Context | Value |
|---------|-------|
| Display titles | -0.03em |
| Headings | -0.01em |
| Body text | normal (0) |
| Uppercase labels | 0.08em |

---

## 3. Spacing Scale (4px base grid)

All spacing uses multiples of 4px:

| Token | Value | Tailwind | Use |
|-------|-------|----------|-----|
| `xs` | 4px | `1` | Tight gaps, inline spacing |
| `sm` | 8px | `2` | Between related items |
| `md` | 12px | `3` | Section padding (vertical) |
| `lg` | 16px | `4` | Card padding, sidebar padding |
| `xl` | 20px | `5` | Page section gaps |
| `2xl` | 24px | `6` | Panel horizontal padding (standard) |
| `3xl` | 32px | `8` | Page container padding (desktop) |

### Standard Padding Patterns
| Element | Padding | Notes |
|---------|---------|-------|
| Page container | `px-4 py-8 md:px-8 md:py-12` | Responsive |
| Card (ExecutionCard) | `p-6` (24px) | All sides equal |
| Panel sections (Header, Info, etc.) | `12px 24px` | Consistent across ALL sections |
| Panel header | `16px 24px` | Taller for primary header |
| Form container | `p-7` (28px) | Slightly more than card |
| Dialog | `p-8` (32px) | Most generous |
| Node list item | `px-4 py-3` (16px/12px) | Compact for list density |
| Sidebar | `p-5` (20px) | |
| Tab buttons | `px-4 py-2` (16px/8px) | |

### Standard Gaps
| Context | Gap | Tailwind |
|---------|-----|----------|
| Between cards | 20px | `gap-5` |
| Between stat cards | 12-16px | `gap-3 md:gap-4` |
| Between node list items | 6px | `mb-1.5` |
| Between form fields | 12px | `gap-3` |
| Between buttons | 8px | `gap-2` |
| Between inline metadata | 8px | `gap-2` |
| Section label to content | 4px | implicit |

---

## 4. Border Radius Scale

| Token | Value | Use |
|-------|-------|-----|
| `sm` | 6px | Small badges, pills, inline buttons |
| `md` | 8px | Inputs (inner), pre blocks, back button |
| `lg` | 12px | Skeleton rows |
| `xl` | 16px | Buttons, inputs, node list items, stat cards |
| `2xl` | 20px | Cards, dialogs, forms |
| `full` | 9999px | Badges, status dots |

**Rule:** Containers use `2xl` (20px). Interactive elements use `xl` (16px). Never mix.

---

## 5. Shadows

| Token | Value | Use |
|-------|-------|-----|
| `card` | `0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.15)` | Cards at rest |
| `card-hover` | `0 2px 8px rgba(0,0,0,0.2), 0 12px 28px rgba(0,0,0,0.18)` | Cards on hover |
| `dialog` | `0 8px 40px rgba(0,0,0,0.4), 0 0 1px rgba(255,255,255,0.03)` | Modals |
| `glow-{color}` | `0 0 N rgba(color, opacity)` | Status glow on active elements |

**Rule:** Every elevated surface has a shadow. No shadow = flush with background.

---

## 6. Borders

| Width | Use |
|-------|-----|
| 1px | Standard borders everywhere |
| 3px | Left accent on error bars, gate sections, card status indicators |

**Rule:** Only two border widths exist. Never 2px or 4px.

---

## 7. Buttons

### Variants
| Variant | Background | Text | Border | Shadow | Use |
|---------|-----------|------|--------|--------|-----|
| `primary` | `bg-blue-600` | white | none | blue glow | Primary actions (Launch, Resume) |
| `secondary` | `#2d2a26` | `#d4cfc5` | `#4a4742` | subtle drop | Secondary actions (Redo) |
| `ghost` | transparent | `#b1ada1` | none | none | Tertiary actions (Cancel, Skip) |
| `danger` | `bg-red-600` | white | none | red glow | Destructive (Stop, Reject) |

### Sizes
| Size | Height | Font | Padding |
|------|--------|------|---------|
| `sm` | 32px | 12px | `px-3 py-1.5` |
| `md` | 36px | 14px | `px-4 py-2` |

### Inline Action Buttons (Controls, Gate, Header)
| Property | Value |
|----------|-------|
| Padding | `4px 12px` |
| Font size | 11px |
| Font weight | 500 |
| Border radius | 6px |
| Background | `${color}18` (10% opacity) |
| Border | `1px solid ${color}33` (20% opacity) |
| Transition | `all 150ms` |

### States
| State | Effect |
|-------|--------|
| Hover | Lighten background (not darken) |
| Active | `scale(0.97)` |
| Disabled | `opacity: 0.5`, `cursor: not-allowed` |
| Loading | Spinner replaces text (4px border, 0.6s spin) |

---

## 8. Cards

### Surface Treatment
- Background: `linear-gradient(to bottom, surface, raised)` — subtle top-to-bottom
- Border: `1px solid subtle` — barely visible at rest
- Border hover: `1px solid strong`
- Top accent: `1px h gradient (transparent -> rgba(255,255,255,0.06) -> transparent)`
- Shadow: `card` at rest, `card-hover` on hover
- Hover: `translateY(-4px)` lift

### Status Left Border
- 3px left border in status color
- Completed: `emerald-400/70`
- Running: `blue-400`
- Failed: `red-400`
- Gated: `amber-400`

---

## 9. Transitions and Animation

### Durations
| Duration | Use |
|----------|-----|
| 150ms | Button/control interactions, micro-feedback |
| 200ms | General transitions (hover, color, opacity) |
| 300ms | Card entrance, panel transitions |
| 500ms | Progress bar, content loading |

### Easing
| Curve | Use |
|-------|-----|
| `ease` | Fade in/out |
| `cubic-bezier(0.16, 1, 0.3, 1)` | Card entrance (spring-like) |
| `step-end` | Cursor blink |
| `ease-in-out` | Pulse animations |

### Named Animations
| Name | Effect | Duration |
|------|--------|----------|
| `card-enter` | translateY(8px) + scale(0.98) -> normal | 300ms |
| `fade-in` | opacity 0 -> 1 | 200ms |
| `slide-up` | translateY(4px) + opacity 0 -> normal | 200ms |
| `pulse-status` | opacity 1 -> 0.3 -> 1 | 1.5s infinite |
| `blink-cursor` | opacity 1 -> 0 -> 1 | 1s step-end |
| `shimmer` | background-position sweep | 1.5s |

---

## 10. Layout Patterns

### Page Layout
- Max width: `4xl` (64rem / 1024px)
- Centered: `mx-auto`
- Responsive padding: `px-4 py-8 md:px-8 md:py-12`

### Two-Panel (Detail Page)
- Sidebar: `380px` desktop, `full` width mobile (max `35dvh`)
- Content: `flex-1`
- Divider: `1px border-subtle`
- Sidebar background: `raised` (#201d18) — slightly different from base

### Collapsible Sidebar
- Expanded: `380px` with full node cards
- Collapsed: `48px` with status dots only

### Responsive Breakpoints
| Breakpoint | Width | Behavior |
|-----------|-------|----------|
| Mobile | < 768px | Stack layout, sidebar on top |
| Tablet | 768px+ | Side-by-side, sidebar left |
| Desktop | 1024px+ | Full layout |

---

## 11. Accessibility

| Requirement | Implementation |
|-------------|---------------|
| Focus ring | `2px solid rgba(217, 119, 87, 0.5)`, offset 2px |
| Touch targets | Minimum 32px (buttons), 44px (back arrow) |
| Color contrast | All text >= 4.5:1 against background (AA) |
| Keyboard nav | `j/k` nodes, `Escape` deselect, `Enter/Space` activate |
| ARIA | `role="button"`, `role="log"`, `aria-live="polite"`, `aria-label` |

---

## 12. Ambient Effects

| Effect | Value |
|--------|-------|
| Page glow | `radial-gradient(ellipse 80% 50% at 50% -20%, rgba(217,119,87,0.15), transparent)` at 800px height |
| Selection | `rgba(217, 119, 87, 0.2)` background, `#e8e6e3` text |
| Scrollbar | 6px width, `#4a4742` thumb, `#5a5650` hover, transparent track |
