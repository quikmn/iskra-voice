// The built-in looks. "Iskra" is the default; the other ten are the ones shown on iskra.foo.
import type { ThemeFile } from './theme'

export interface BuiltInTheme {
  id: string
  theme: ThemeFile
}

export const DEFAULT_THEME_ID = 'iskra'

export const BUILT_IN_THEMES: BuiltInTheme[] = [
  {
    id: 'iskra',
    theme: {
      meta: { name: 'Iskra', desc: 'The default: deep night with a violet spark', scheme: 'dark' },
      colors: {
        bgSurface: '#08080f', bgDeep: '#0b0b14', bgBody: '#07070d', bgFloat: '#1b1b30',
        bgSidebar: '#10101c', bgSidebarHover: '#1b1b30', bgChat: '#141424',
        bgHover: '#2f2f4f', bgButton: '#1b1b30', bgBorder: 'rgba(120,100,255,0.14)', bgActive: '#24243d',
        textHeading: '#e2e2f0', textNormal: '#e2e2f0', textMuted: '#b4b4cc', textSubtle: '#8484a8', textFaint: '#4b4b66',
        accent: '#695bff', accentHover: '#5a4bf0', success: '#4ade80', successHover: '#4ade80',
        danger: '#f87171', dangerHover: '#b91c1c', warning: '#fbbf24', link: '#00cfff',
        statusOnline: '#4ade80', statusAway: '#fbbf24', statusDnd: '#f87171',
        mentionBg: 'rgba(124,111,255,0.2)', warningBg: 'rgba(251,191,36,0.1)', dangerBg: 'rgba(248,113,113,0.12)',
        speakingGlow: 'transparent', accentSubtle: 'rgba(124,111,255,0.08)', onAccent: '#ffffff', mentionText: '#c9c3ff',
      },
      radius: 10,
    },
  },
  {
    id: 'catppuccin',
    theme: {
      meta: { name: 'Catppuccin Mocha', desc: 'Soothing pastel palette', scheme: 'dark' },
      colors: {
        bgSurface: '#11111b', bgDeep: '#181825', bgBody: '#1e1e2e', bgFloat: '#181825',
        bgSidebar: '#1e1e2e', bgSidebarHover: '#24243e', bgChat: '#313244',
        bgHover: '#585b70', bgButton: '#45475a', bgBorder: '#45475a', bgActive: '#595b6d',
        textHeading: '#cdd6f4', textNormal: '#cdd6f4', textMuted: '#b3b9d0', textSubtle: '#999db0', textFaint: '#6c7086',
        accent: '#cba6f7', accentHover: '#b08de0', success: '#a6e3a1', successHover: '#8bc987',
        danger: '#f38ba8', dangerHover: '#d6728e', warning: '#fab387', link: '#89dceb',
        statusOnline: '#a6e3a1', statusAway: '#f9e2af', statusDnd: '#f38ba8',
        mentionBg: 'rgba(203,166,247,0.25)', warningBg: 'rgba(249,226,175,0.12)', dangerBg: 'rgba(243,139,168,0.15)',
        speakingGlow: 'rgba(166,227,161,0.4)', accentSubtle: 'rgba(203,166,247,0.08)',
      },
      radius: 12,
    },
  },
  {
    id: 'dracula',
    theme: {
      meta: { name: 'Dracula', desc: 'Vibrant purple accents', scheme: 'dark' },
      colors: {
        bgSurface: '#191a21', bgDeep: '#21222c', bgBody: '#21222c', bgFloat: '#1e1f29',
        bgSidebar: '#282a36', bgSidebarHover: '#30324a', bgChat: '#353748',
        bgHover: '#54576e', bgButton: '#44475a', bgBorder: '#3d3f58', bgActive: '#566594',
        textHeading: '#f8f8f2', textNormal: '#e8e8de', textMuted: '#aeb8d7', textSubtle: '#97a2c6', textFaint: '#505878',
        accent: '#bd93f9', accentHover: '#a67fd5', success: '#50fa7b', successHover: '#38d966',
        danger: '#ff7979', dangerHover: '#e03535', warning: '#ffb86c', link: '#8be9fd',
        statusOnline: '#50fa7b', statusAway: '#ffb86c', statusDnd: '#ff5555',
        mentionBg: 'rgba(189,147,249,0.25)', warningBg: 'rgba(255,184,108,0.12)', dangerBg: 'rgba(255,85,85,0.15)',
        speakingGlow: 'rgba(80,250,123,0.4)', accentSubtle: 'rgba(189,147,249,0.08)',
      },
      radius: 8,
    },
  },
  {
    id: 'tokyonight',
    theme: {
      meta: { name: 'Tokyo Night', desc: 'Inspired by Tokyo after dark', scheme: 'dark' },
      colors: {
        bgSurface: '#13141c', bgDeep: '#16161e', bgBody: '#1a1b26', bgFloat: '#16161e',
        bgSidebar: '#1f2335', bgSidebarHover: '#252a40', bgChat: '#2a2f48',
        bgHover: '#3d4466', bgButton: '#363b5e', bgBorder: '#3b4261', bgActive: '#3c4264',
        textHeading: '#c0caf5', textNormal: '#a9b1d6', textMuted: '#9ba9cd', textSubtle: '#8b99c2', textFaint: '#5a6490',
        accent: '#7aa2f7', accentHover: '#5e86e0', success: '#9ece6a', successHover: '#84b552',
        danger: '#f7768e', dangerHover: '#e05a72', warning: '#e0af68', link: '#2ac3de',
        statusOnline: '#9ece6a', statusAway: '#e0af68', statusDnd: '#f7768e',
        mentionBg: 'rgba(122,162,247,0.25)', warningBg: 'rgba(224,175,104,0.12)', dangerBg: 'rgba(247,118,142,0.15)',
        speakingGlow: 'rgba(158,206,106,0.4)', accentSubtle: 'rgba(122,162,247,0.08)',
      },
      radius: 10,
    },
  },
  {
    id: 'nord',
    theme: {
      meta: { name: 'Nord', desc: 'Arctic, north-bluish palette', scheme: 'dark' },
      colors: {
        bgSurface: '#242933', bgDeep: '#2e3440', bgBody: '#2e3440', bgFloat: '#2e3440',
        bgSidebar: '#353c4a', bgSidebarHover: '#404b5e', bgChat: '#3b4252',
        bgHover: '#566071', bgButton: '#434c5e', bgBorder: '#6b7a8f', bgActive: '#516179',
        textHeading: '#eceff4', textNormal: '#d8dee9', textMuted: '#a8c1d9', textSubtle: '#a4b1c2', textFaint: '#7089a0',
        accent: '#88c0d0', accentHover: '#7ab0c0', success: '#a3be8c', successHover: '#8ca876',
        danger: '#d9a2a8', dangerHover: '#a05059', warning: '#ebcb8b', link: '#9dc5c4',
        statusOnline: '#a3be8c', statusAway: '#ebcb8b', statusDnd: '#bf616a',
        mentionBg: 'rgba(136,192,208,0.25)', warningBg: 'rgba(235,203,139,0.12)', dangerBg: 'rgba(191,97,106,0.15)',
        speakingGlow: 'rgba(163,190,140,0.4)', accentSubtle: 'rgba(136,192,208,0.08)',
      },
      radius: 6,
    },
  },
  {
    id: 'onedark',
    theme: {
      meta: { name: 'One Dark', desc: "Atom's iconic dark theme", scheme: 'dark' },
      colors: {
        bgSurface: '#1a1d23', bgDeep: '#21252b', bgBody: '#1d2025', bgFloat: '#21252b',
        bgSidebar: '#21252b', bgSidebarHover: '#272b33', bgChat: '#2f333d',
        bgHover: '#333840', bgButton: '#343a44', bgBorder: '#3e4452', bgActive: '#3d4250',
        textHeading: '#abb2bf', textNormal: '#abb2bf', textMuted: '#a1a5ac', textSubtle: '#999daa', textFaint: '#636b7a',
        accent: '#61afef', accentHover: '#4d9de0', success: '#98c379', successHover: '#82aa65',
        danger: '#e47f87', dangerHover: '#c45a62', warning: '#e5c07b', link: '#56b6c2',
        statusOnline: '#98c379', statusAway: '#e5c07b', statusDnd: '#e06c75',
        mentionBg: 'rgba(97,175,239,0.25)', warningBg: 'rgba(229,192,123,0.12)', dangerBg: 'rgba(224,108,117,0.15)',
        speakingGlow: 'rgba(152,195,121,0.4)', accentSubtle: 'rgba(97,175,239,0.08)',
      },
      radius: 8,
    },
  },
  {
    id: 'solarized',
    theme: {
      meta: { name: 'Solarized Dark', desc: 'Precision colors for machines and people', scheme: 'dark' },
      colors: {
        bgSurface: '#001f27', bgDeep: '#002531', bgBody: '#002b36', bgFloat: '#003541',
        bgSidebar: '#002b36', bgSidebarHover: '#0a3a47', bgChat: '#073642',
        bgHover: '#156070', bgButton: '#0b394a', bgBorder: '#195060', bgActive: '#143943',
        textHeading: '#fdf6e3', textNormal: '#93a1a1', textMuted: '#86a4ab', textSubtle: '#8fa3aa', textFaint: '#4e7085',
        accent: '#268bd2', accentHover: '#1e6fa6', success: '#90a600', successHover: '#6b7d00',
        danger: '#e87977', dangerHover: '#b22826', warning: '#ec7b4c', link: '#2fb1a8',
        statusOnline: '#859900', statusAway: '#b58900', statusDnd: '#dc322f',
        mentionBg: 'rgba(38,139,210,0.25)', warningBg: 'rgba(203,75,22,0.12)', dangerBg: 'rgba(220,50,47,0.15)',
        speakingGlow: 'rgba(133,153,0,0.4)', accentSubtle: 'rgba(38,139,210,0.08)',
      },
      radius: 4,
      fonts: { body: 'system' },
    },
  },
  {
    id: 'default',
    theme: {
      meta: { name: 'Iskra Dark', desc: 'Calm greys with a blurple accent', scheme: 'dark' },
      colors: {
        bgSurface: '#111214', bgDeep: '#1e1f22', bgBody: '#202225', bgFloat: '#232428',
        bgSidebar: '#2b2d31', bgSidebarHover: '#25272b', bgChat: '#313338',
        bgHover: '#35373c', bgButton: '#383a40', bgBorder: '#3a3c42', bgActive: '#3f4147',
        textHeading: '#ffffff', textNormal: '#dcddde', textMuted: '#9fa6ad', textSubtle: '#999da2', textFaint: '#6b7178',
        accent: '#5865f2', accentHover: '#4752c4', success: '#40b264', successHover: '#2d8a4e',
        danger: '#f2787a', dangerHover: '#c03537', warning: '#faa61a', link: '#00b1f7',
        statusOnline: '#3ba55d', statusAway: '#faa61a', statusDnd: '#ed4245',
        mentionBg: 'rgba(88,101,242,0.25)', warningBg: 'rgba(250,166,26,0.12)', dangerBg: 'rgba(237,66,69,0.15)',
        speakingGlow: 'rgba(59,165,93,0.40)', accentSubtle: 'rgba(88,101,242,0.08)',
      },
      radius: 8,
      fonts: { body: 'system' },
    },
  },
  {
    id: 'synthwave',
    theme: {
      meta: { name: 'Synthwave 1984', desc: 'Outrun the grid with neon pinks and deep purples', scheme: 'dark' },
      colors: {
        bgSurface: '#0d0221', bgDeep: '#0f0524', bgBody: '#150633', bgFloat: '#1a0840',
        bgSidebar: '#1a0840', bgSidebarHover: '#261447', bgChat: '#210b45',
        bgHover: '#2e1c5c', bgButton: '#3a1c71', bgBorder: '#4d2b85', bgActive: '#5c2a9e',
        textHeading: '#ffffff', textNormal: '#e0e0e0', textMuted: '#b39ddb', textSubtle: '#9575cd', textFaint: '#673ab7',
        accent: '#ff007f', accentHover: '#e60073', success: '#39ff14', successHover: '#32e612',
        danger: '#ff3131', dangerHover: '#d92b2b', warning: '#ff9a00', link: '#00f3ff',
        statusOnline: '#39ff14', statusAway: '#ff9a00', statusDnd: '#ff3131',
        mentionBg: 'rgba(255,0,127,0.25)', warningBg: 'rgba(255,154,0,0.12)', dangerBg: 'rgba(255,49,49,0.15)',
        speakingGlow: 'rgba(57,255,20,0.4)', accentSubtle: 'rgba(255,0,127,0.08)',
      },
      radius: 14,
      fonts: { body: 'rounded' },
    },
  },
  {
    id: 'cyberlime',
    theme: {
      meta: { name: 'Cyber-Lime', desc: 'Digital rain and terminal aesthetics', scheme: 'dark' },
      colors: {
        bgSurface: '#020a02', bgDeep: '#050f05', bgBody: '#0a140a', bgFloat: '#0d1a0d',
        bgSidebar: '#0d1a0d', bgSidebarHover: '#142614', bgChat: '#0d1f0d',
        bgHover: '#1b331b', bgButton: '#1e3d1e', bgBorder: '#2a4d2a', bgActive: '#285028',
        textHeading: '#d0ffd0', textNormal: '#a0c0a0', textMuted: '#8ea78e', textSubtle: '#749a74', textFaint: '#305030',
        accent: '#39ff14', accentHover: '#32e612', success: '#39ff14', successHover: '#32e612',
        danger: '#ff4444', dangerHover: '#cc3333', warning: '#f0ad4e', link: '#00ffcc',
        statusOnline: '#39ff14', statusAway: '#f0ad4e', statusDnd: '#ff4444',
        mentionBg: 'rgba(57,255,20,0.25)', warningBg: 'rgba(240,173,78,0.12)', dangerBg: 'rgba(255,68,68,0.15)',
        speakingGlow: 'rgba(57,255,20,0.4)', accentSubtle: 'rgba(57,255,20,0.08)',
      },
      radius: 2,
      avatarShape: 'square',
      fonts: { body: 'mono' },
    },
  },
  {
    id: 'bloodmoon',
    theme: {
      meta: { name: 'Blood Moon', desc: 'High-contrast darkness with crimson strikes', scheme: 'dark' },
      colors: {
        bgSurface: '#0a0000', bgDeep: '#0f0505', bgBody: '#140a0a', bgFloat: '#1a0d0d',
        bgSidebar: '#1a0d0d', bgSidebarHover: '#261414', bgChat: '#1c0f0f',
        bgHover: '#331b1b', bgButton: '#4d1a1a', bgBorder: '#662222', bgActive: '#7a2828',
        textHeading: '#ffffff', textNormal: '#e0c0c0', textMuted: '#b18a8a', textSubtle: '#b07b7b', textFaint: '#503030',
        accent: '#ff3333', accentHover: '#cc0000', success: '#00ff88', successHover: '#00cc6e',
        danger: '#ff0000', dangerHover: '#cc0000', warning: '#ffaa00', link: '#ff66cc',
        statusOnline: '#00ff88', statusAway: '#ffaa00', statusDnd: '#ff0000',
        mentionBg: 'rgba(255,51,51,0.25)', warningBg: 'rgba(255,170,0,0.12)', dangerBg: 'rgba(255,0,0,0.15)',
        speakingGlow: 'rgba(0,255,136,0.4)', accentSubtle: 'rgba(255,51,51,0.08)',
      },
      radius: 6,
      avatarShape: 'rounded',
    },
  },
]
