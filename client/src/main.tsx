// Decides which account this page is for before anything else loads (platform/accountBoot.ts), then starts either
// one account's app or, with several accounts signed in, the host page that holds one frame per account.
import { bootMode, storageIsolated } from './platform/accountBoot'
import './styles.css'

if (bootMode === 'host') void import('./hostMain').then(({ startHostPage }) => startHostPage())
else if (!storageIsolated) void import('./hostMain').then(({ showUnsupported }) => showUnsupported())
else void import('./appMain')
