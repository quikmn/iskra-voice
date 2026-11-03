// The shared UI kit: use these instead of building another switch, toast, tab bar or empty state.
// Tokens (type, spacing, corners, elevation, focus, motion) live in :root in styles.css.
import './kit.css'

export { Switch } from './Switch'
export { Field, SaveBar, SavedTick, SettingRow, SwitchRow, useSavedFlash } from './Settings'
export { Badge, Chip, EmptyState, ListRow, type Tone } from './Display'
export { Segmented, TabPanel, Tabs, type TabItem } from './Tabs'
export { Toast, ToastPill, ToastPortal, type ToastLane } from './Toast'
export { MenuGroup, MenuItem, MenuTitle, OrgMenu as Menu, type MenuAnchor } from '../organize/OrgMenu'
