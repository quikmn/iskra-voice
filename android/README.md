# Android (moved)

The Android app is now built from the same Capacitor shell as the iPhone app: **[mobile/](../mobile/README.md)**
(`mobile/android/`, built and signed by `mobile/scripts/build-android.ps1`).

This folder used to hold a Trusted Web Activity (Bubblewrap) that ran https://app.iskra.foo full screen. It shipped up
to 2.0.0-alpha.7 (version code 20000107). The Capacitor app keeps its package id `foo.iskra.app`, its signing key
(`devkeys\iskra-android.keystore`, alias `iskra`) and its version code scheme, so installed copies update in place to
the new app. `client/public/.well-known/assetlinks.json` is unchanged (it now verifies the app's App Links), and the
client still recognises the old app's `android-app://` referrer for anyone who hasn't updated yet.

The old project is in git history (`git log -- android/`).
