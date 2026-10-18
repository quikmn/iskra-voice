// Decides which account this page is for before anything else loads (platform/accountBoot.ts), then starts either
// one account's app or, with several accounts signed in, the host page that holds one frame per account. Both are
// loaded up front (a dynamic import makes the first start slower); in the host page the app's modules stay idle: they
// see no desktop or phone shell and only an in-memory storage (accountBoot.ts).
import { bootMode, storageIsolated } from './platform/accountBoot'
import './styles.css'
import { startApp } from './appMain'
import { showUnsupported, startHostPage } from './hostMain'

if (bootMode === 'host') startHostPage()
else if (!storageIsolated) showUnsupported()
else startApp()
