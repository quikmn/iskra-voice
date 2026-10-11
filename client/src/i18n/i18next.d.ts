// Typed keys: t('chat.send') is checked against the English catalog, and so are its {{variables}}.
import 'i18next'
import type { en } from './en'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: typeof en }
    returnNull: false
  }
}
