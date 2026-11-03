// The built-in looks. "Iskra" is the default and the one source of the default look: styles.css :root and the
// fallbacks in theme.ts hold the same values (theme.test.ts checks), and so does the theme section on iskra.foo
// (scripts/build-site-docs.mjs writes it from this file).
//
// Every built-in follows the same rules (theme.test.ts checks them): one lightness ladder for the surfaces (rail <
// wells < sidebar < chat < menus and dialogs < buttons < hover < selected, on dark themes), visible hover and
// selected states, text that steps down (heading >= normal > muted > subtle), one accent at least 40 degrees of hue
// from danger, and red, green and yellow that never double as the accent. None names a font, a corner radius other
// than 10 or an avatar shape: those are the person's own settings (Font in Appearance).
// Only type imports here: the site build loads this file with plain Node.
import type { ThemeFile } from './theme'

export type ThemeGroup = 'house' | 'classic' | 'loud'

export interface BuiltInTheme {
  id: string
  /** Which row of the Appearance page it's shown in. */
  group: ThemeGroup
  theme: ThemeFile
}

export const DEFAULT_THEME_ID = 'iskra'

/** Built-in ids that were renamed: old saved choice -> current id. */
export const RENAMED_THEME_IDS: Record<string, string> = { default: 'graphite' }

export const BUILT_IN_THEMES: BuiltInTheme[] = [
  {
    id: 'iskra',
    group: 'house',
    theme: {
      meta: { name: 'Iskra', desc: 'The default: deep night with a violet spark', scheme: 'dark' },
      colors: {
        bgSurface: '#080714', bgBody: '#080714', bgDeep: '#0c0b19', bgSidebar: '#10101f', bgSidebarHover: '#191a2b', bgChat: '#141424',
        bgFloat: '#1d1d2f', bgButton: '#242438', bgHover: '#27283c', bgActive: '#2d2e44', bgBorder: 'rgba(120,100,255,0.14)',
        textHeading: '#ececf8', textNormal: '#e2e2f0', textMuted: '#b4b4cc', textSubtle: '#8a8aae', textFaint: '#4b4b66',
        accent: '#695bff', accentHover: '#5c4aed', onAccent: '#ffffff', link: '#00cfff',
        success: '#4ade80', successHover: '#2eca6d', danger: '#f87171', dangerHover: '#dc575a', warning: '#fbbf24',
        statusOnline: '#4ade80', statusAway: '#fbbf24', statusDnd: '#f87171',
        mentionBg: 'rgba(105,91,255,0.18)', mentionText: '#c4caff',
        warningBg: 'rgba(251,191,36,0.12)', dangerBg: 'rgba(248,113,113,0.12)', accentSubtle: 'rgba(105,91,255,0.1)', speakingGlow: 'rgba(74,222,128,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'daylight',
    group: 'house',
    theme: {
      meta: { name: 'Iskra Light', desc: 'Bright and clear, for daytime', scheme: 'light' },
      colors: {
        bgSurface: '#e3e3ec', bgBody: '#e3e3ec', bgDeep: '#f5f5f9', bgSidebar: '#efeff5', bgSidebarHover: '#e5e5ee', bgChat: '#ffffff',
        bgFloat: '#ffffff', bgButton: '#ebebf2', bgHover: '#f0f0f6', bgActive: '#dddde9', bgBorder: 'rgba(30,25,90,0.14)',
        textHeading: '#0e0e1a', textNormal: '#22222f', textMuted: '#45455a', textSubtle: '#5f5f75', textFaint: '#a3a3b6',
        accent: '#5646e8', accentHover: '#4535d2', onAccent: '#ffffff', link: '#0b62c4',
        success: '#157a3e', successHover: '#0f6431', danger: '#c2262e', dangerHover: '#a11d24', warning: '#8a5300',
        statusOnline: '#1f9d50', statusAway: '#c98a00', statusDnd: '#d93a40',
        mentionBg: 'rgba(86,70,232,0.12)', mentionText: '#3a2cc4',
        warningBg: 'rgba(201,138,0,0.12)', dangerBg: 'rgba(194,38,46,0.08)', accentSubtle: 'rgba(86,70,232,0.08)', speakingGlow: 'rgba(31,157,80,0.30)',
      },
      radius: 10,
    },
  },
  {
    id: 'graphite',
    group: 'house',
    theme: {
      meta: { name: 'Graphite', desc: 'Calm greys with a blurple accent', scheme: 'dark' },
      colors: {
        bgSurface: '#1d1e22', bgBody: '#1d1e22', bgDeep: '#212227', bgSidebar: '#26272c', bgSidebarHover: '#313237', bgChat: '#2b2c31',
        bgFloat: '#35363b', bgButton: '#3d3e43', bgHover: '#414247', bgActive: '#47484e', bgBorder: 'rgba(162,174,203,0.12)',
        textHeading: '#f2f3f5', textNormal: '#dbdee1', textMuted: '#bcc1c8', textSubtle: '#a2a8b1', textFaint: '#5b5d63',
        accent: '#5865f2', accentHover: '#4b55e1', onAccent: '#ffffff', link: '#4cbcff',
        success: '#3fc174', successHover: '#23ae62', danger: '#f78a8c', dangerHover: '#db7174', warning: '#f0b232',
        statusOnline: '#3fc174', statusAway: '#f0b232', statusDnd: '#f78a8c',
        mentionBg: 'rgba(88,101,242,0.18)', mentionText: '#bccdff',
        warningBg: 'rgba(240,178,50,0.12)', dangerBg: 'rgba(247,138,140,0.12)', accentSubtle: 'rgba(88,101,242,0.1)', speakingGlow: 'rgba(63,193,116,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'midnight',
    group: 'house',
    theme: {
      meta: { name: 'Midnight', desc: 'True black, for OLED screens', scheme: 'dark' },
      colors: {
        bgSurface: '#000000', bgBody: '#000000', bgDeep: '#050505', bgSidebar: '#08080a', bgSidebarHover: '#18181d', bgChat: '#0d0d10',
        bgFloat: '#16161a', bgButton: '#1e1e23', bgHover: '#232329', bgActive: '#2a2a31', bgBorder: 'rgba(255,255,255,0.10)',
        textHeading: '#f5f5f7', textNormal: '#e6e6ea', textMuted: '#b9b9c2', textSubtle: '#8e8e99', textFaint: '#4a4a52',
        accent: '#7b6dff', accentHover: '#897dff', onAccent: '#000000', link: '#4cc9ff',
        success: '#4ade80', successHover: '#2eca6d', danger: '#ff7b7b', dangerHover: '#e36263', warning: '#fbbf24',
        statusOnline: '#4ade80', statusAway: '#fbbf24', statusDnd: '#ff7b7b',
        mentionBg: 'rgba(123,109,255,0.18)', mentionText: '#c7c9ff',
        warningBg: 'rgba(251,191,36,0.12)', dangerBg: 'rgba(255,123,123,0.12)', accentSubtle: 'rgba(123,109,255,0.1)', speakingGlow: 'rgba(74,222,128,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'catppuccin',
    group: 'classic',
    theme: {
      meta: { name: 'Catppuccin Mocha', desc: 'Soothing pastel palette', scheme: 'dark' },
      colors: {
        bgSurface: '#11111e', bgBody: '#11111e', bgDeep: '#151523', bgSidebar: '#1a1928', bgSidebarHover: '#242435', bgChat: '#1e1e2e',
        bgFloat: '#272839', bgButton: '#2f2f42', bgHover: '#323346', bgActive: '#39394e', bgBorder: 'rgba(165,164,241,0.12)',
        textHeading: '#cdd6f4', textNormal: '#cdd6f4', textMuted: '#bac2de', textSubtle: '#9da3c0', textFaint: '#585b70',
        accent: '#cba6f7', accentHover: '#dbb6ff', onAccent: '#11111e', link: '#89dceb',
        success: '#a6e3a1', successHover: '#93cf8e', danger: '#f38ba8', dangerHover: '#d7728f', warning: '#f9e2af',
        statusOnline: '#a6e3a1', statusAway: '#f9e2af', statusDnd: '#f38ba8',
        mentionBg: 'rgba(203,166,247,0.18)', mentionText: '#e0c1ff',
        warningBg: 'rgba(249,226,175,0.12)', dangerBg: 'rgba(243,139,168,0.12)', accentSubtle: 'rgba(203,166,247,0.1)', speakingGlow: 'rgba(166,227,161,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'dracula',
    group: 'classic',
    theme: {
      meta: { name: 'Dracula', desc: 'Vibrant purple accents', scheme: 'dark' },
      colors: {
        bgSurface: '#1a1c26', bgBody: '#1a1c26', bgDeep: '#1f202b', bgSidebar: '#232530', bgSidebarHover: '#2e303d', bgChat: '#282a36',
        bgFloat: '#323441', bgButton: '#393c4a', bgHover: '#3d3f4e', bgActive: '#434656', bgBorder: 'rgba(161,169,228,0.12)',
        textHeading: '#f8f8f2', textNormal: '#ecece6', textMuted: '#c5c9dc', textSubtle: '#a4acd0', textFaint: '#6272a4',
        accent: '#bd93f9', accentHover: '#cda3ff', onAccent: '#1a1c26', link: '#8be9fd',
        success: '#50fa7b', successHover: '#32e667', danger: '#ff6e6e', dangerHover: '#e25456', warning: '#ffb86c',
        statusOnline: '#50fa7b', statusAway: '#ffb86c', statusDnd: '#ff6e6e',
        mentionBg: 'rgba(189,147,249,0.18)', mentionText: '#ddc2ff',
        warningBg: 'rgba(255,184,108,0.12)', dangerBg: 'rgba(255,110,110,0.12)', accentSubtle: 'rgba(189,147,249,0.1)', speakingGlow: 'rgba(80,250,123,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'tokyonight',
    group: 'classic',
    theme: {
      meta: { name: 'Tokyo Night', desc: 'Inspired by Tokyo after dark', scheme: 'dark' },
      colors: {
        bgSurface: '#0d0e17', bgBody: '#0d0e17', bgDeep: '#11121c', bgSidebar: '#151721', bgSidebarHover: '#1f212d', bgChat: '#1a1b26',
        bgFloat: '#232531', bgButton: '#2a2c39', bgHover: '#2d303d', bgActive: '#343644', bgBorder: 'rgba(161,169,227,0.12)',
        textHeading: '#c0caf5', textNormal: '#c0caf5', textMuted: '#a9b1d6', textSubtle: '#8b93bf', textFaint: '#565f89',
        accent: '#7aa2f7', accentHover: '#89b2ff', onAccent: '#0d0e17', link: '#7dcfff',
        success: '#9ece6a', successHover: '#8cbb57', danger: '#f7768e', dangerHover: '#db5d76', warning: '#e0af68',
        statusOnline: '#9ece6a', statusAway: '#e0af68', statusDnd: '#f7768e',
        mentionBg: 'rgba(122,162,247,0.18)', mentionText: '#b0d1ff',
        warningBg: 'rgba(224,175,104,0.12)', dangerBg: 'rgba(247,118,142,0.12)', accentSubtle: 'rgba(122,162,247,0.1)', speakingGlow: 'rgba(158,206,106,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'nord',
    group: 'classic',
    theme: {
      meta: { name: 'Nord', desc: 'Arctic, north-bluish palette', scheme: 'dark' },
      colors: {
        bgSurface: '#20252f', bgBody: '#20252f', bgDeep: '#252a35', bgSidebar: '#292f3a', bgSidebarHover: '#343a47', bgChat: '#2e3440',
        bgFloat: '#383e4c', bgButton: '#3f4655', bgHover: '#434a59', bgActive: '#495161', bgBorder: 'rgba(145,174,231,0.12)',
        textHeading: '#eceff4', textNormal: '#e5e9f0', textMuted: '#c8cfdb', textSubtle: '#b0bbcc', textFaint: '#616e88',
        accent: '#88c0d0', accentHover: '#98d0e0', onAccent: '#20252f', link: '#8fbcbb',
        success: '#a3be8c', successHover: '#91ab7a', danger: '#ec9aa1', dangerHover: '#d18189', warning: '#ebcb8b',
        statusOnline: '#a3be8c', statusAway: '#ebcb8b', statusDnd: '#ec9aa1',
        mentionBg: 'rgba(136,192,208,0.18)', mentionText: '#a3dcec',
        warningBg: 'rgba(235,203,139,0.12)', dangerBg: 'rgba(236,154,161,0.12)', accentSubtle: 'rgba(136,192,208,0.1)', speakingGlow: 'rgba(163,190,140,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'onedark',
    group: 'classic',
    theme: {
      meta: { name: 'One Dark', desc: "Atom's iconic blue-grey dark theme", scheme: 'dark' },
      colors: {
        bgSurface: '#1a1e25', bgBody: '#1a1e25', bgDeep: '#1e222a', bgSidebar: '#23272f', bgSidebarHover: '#2e323a', bgChat: '#282c34',
        bgFloat: '#32363e', bgButton: '#3a3e46', bgHover: '#3d424a', bgActive: '#444851', bgBorder: 'rgba(171,178,191,0.12)',
        textHeading: '#e6e9ef', textNormal: '#ccd1da', textMuted: '#b3bac6', textSubtle: '#9ba2b0', textFaint: '#5c6370',
        accent: '#61afef', accentHover: '#71bfff', onAccent: '#1a1e25', link: '#56b6c2',
        success: '#98c379', successHover: '#85af67', danger: '#ef838b', dangerHover: '#d16a73', warning: '#e5c07b',
        statusOnline: '#98c379', statusAway: '#e5c07b', statusDnd: '#ef838b',
        mentionBg: 'rgba(97,175,239,0.18)', mentionText: '#a9d4ff',
        warningBg: 'rgba(229,192,123,0.12)', dangerBg: 'rgba(239,131,139,0.12)', accentSubtle: 'rgba(97,175,239,0.1)', speakingGlow: 'rgba(152,195,121,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'solarized',
    group: 'classic',
    theme: {
      meta: { name: 'Solarized Dark', desc: 'Precision colours for machines and people', scheme: 'dark' },
      colors: {
        bgSurface: '#001c27', bgBody: '#001c27', bgDeep: '#00212c', bgSidebar: '#002631', bgSidebarHover: '#06313d', bgChat: '#002b36',
        bgFloat: '#0b3540', bgButton: '#153d49', bgHover: '#19414d', bgActive: '#204853', bgBorder: 'rgba(147,161,161,0.14)',
        textHeading: '#fdf6e3', textNormal: '#e3e3d8', textMuted: '#b2c0c0', textSubtle: '#93a7a9', textFaint: '#586e75',
        accent: '#268bd2', accentHover: '#3a9be3', onAccent: '#001c27', link: '#35b8ad',
        success: '#a3b61f', successHover: '#8fa10a', danger: '#f2776c', dangerHover: '#d4514a', warning: '#d6a520',
        statusOnline: '#a3b61f', statusAway: '#d6a520', statusDnd: '#f2776c',
        mentionBg: 'rgba(38,139,210,0.18)', mentionText: '#9ccdf2',
        warningBg: 'rgba(214,165,32,0.12)', dangerBg: 'rgba(242,119,108,0.12)', accentSubtle: 'rgba(38,139,210,0.1)', speakingGlow: 'rgba(163,182,31,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'synthwave',
    group: 'loud',
    theme: {
      meta: { name: 'Synthwave 1984', desc: 'Outrun the grid with neon pinks and deep purples', scheme: 'dark' },
      colors: {
        bgSurface: '#10061f', bgBody: '#10061f', bgDeep: '#150925', bgSidebar: '#190d2b', bgSidebarHover: '#241738', bgChat: '#1e1131',
        bgFloat: '#281a3d', bgButton: '#302147', bgHover: '#33244b', bgActive: '#3a2a54', bgBorder: 'rgba(186,156,239,0.16)',
        textHeading: '#ffffff', textNormal: '#ece6f6', textMuted: '#c9b9e6', textSubtle: '#a58fcf', textFaint: '#615971',
        accent: '#ff3ea5', accentHover: '#ff52b5', onAccent: '#10061f', link: '#36f9f6',
        success: '#72f1b8', successHover: '#5cdda5', danger: '#ff7a59', dangerHover: '#e36040', warning: '#fede5d',
        statusOnline: '#72f1b8', statusAway: '#fede5d', statusDnd: '#ff7a59',
        mentionBg: 'rgba(255,62,165,0.18)', mentionText: '#ffb6d6',
        warningBg: 'rgba(254,222,93,0.12)', dangerBg: 'rgba(255,122,89,0.12)', accentSubtle: 'rgba(255,62,165,0.1)', speakingGlow: 'rgba(114,241,184,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'cyberlime',
    group: 'loud',
    theme: {
      meta: { name: 'Cyber-Lime', desc: 'Digital rain and terminal aesthetics', scheme: 'dark' },
      colors: {
        bgSurface: '#020903', bgBody: '#020903', bgDeep: '#050d05', bgSidebar: '#081209', bgSidebarHover: '#121c12', bgChat: '#0c160d',
        bgFloat: '#151f16', bgButton: '#1c261d', bgHover: '#1f2a20', bgActive: '#253026', bgBorder: 'rgba(160,255,120,0.12)',
        textHeading: '#eaffe6', textNormal: '#d2e8cf', textMuted: '#a5c0a2', textSubtle: '#80a07d', textFaint: '#3b4f3a',
        accent: '#daf537', accentHover: '#eaff4f', onAccent: '#020903', link: '#5cc8ff',
        success: '#46fbae', successHover: '#2ee598', danger: '#ff6b6b', dangerHover: '#e35253', warning: '#ffc94d',
        statusOnline: '#46fbae', statusAway: '#ffc94d', statusDnd: '#ff6b6b',
        mentionBg: 'rgba(218,245,55,0.18)', mentionText: '#eaff9a',
        warningBg: 'rgba(255,201,77,0.12)', dangerBg: 'rgba(255,107,107,0.12)', accentSubtle: 'rgba(218,245,55,0.1)', speakingGlow: 'rgba(70,251,174,0.35)',
      },
      radius: 10,
    },
  },
  {
    id: 'bloodmoon',
    group: 'loud',
    theme: {
      meta: { name: 'Blood Moon', desc: 'Darkness lit by a crimson moon', scheme: 'dark' },
      colors: {
        bgSurface: '#0c0406', bgBody: '#0c0406', bgDeep: '#110709', bgSidebar: '#150b0e', bgSidebarHover: '#201518', bgChat: '#1a0f12',
        bgFloat: '#24181b', bgButton: '#2b1f22', bgHover: '#2f2226', bgActive: '#35292c', bgBorder: 'rgba(255,110,130,0.13)',
        textHeading: '#fff2f2', textNormal: '#f0dcdc', textMuted: '#c9a9ab', textSubtle: '#a88487', textFaint: '#55383c',
        accent: '#ed46a5', accentHover: '#ff58b4', onAccent: '#0c0406', link: '#ffb36b',
        success: '#5ee8a0', successHover: '#47d48b', danger: '#fe6652', dangerHover: '#e14d3b', warning: '#ffd45e',
        statusOnline: '#5ee8a0', statusAway: '#ffd45e', statusDnd: '#fe6652',
        mentionBg: 'rgba(237,70,165,0.18)', mentionText: '#ffb0d8',
        warningBg: 'rgba(255,212,94,0.12)', dangerBg: 'rgba(254,102,82,0.12)', accentSubtle: 'rgba(237,70,165,0.1)', speakingGlow: 'rgba(94,232,160,0.35)',
      },
      radius: 10,
    },
  },
]

/** The default look (Iskra). */
export const DEFAULT_THEME: ThemeFile = BUILT_IN_THEMES[0].theme
