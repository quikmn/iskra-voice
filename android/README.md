# Iskra for Android

An installable Android app that runs https://app.iskra.foo full screen as a
[Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity) (Chrome's engine, no browser bar).
Web push arrives as the app's own notifications (notification delegation), and microphone and camera work as they do in Chrome.
Package id `foo.iskra.app`, minimum Android 6.

The project was generated with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) (`@bubblewrap/cli` 1.25.0)
from `twa-manifest.json`, on top of Google's `androidbrowserhelper` library.

## Build

```powershell
.\android\build.ps1           # android\release\Iskra-<version>.apk and .aab, signed
.\android\build.ps1 -ApkOnly
```

The version comes from `desktop/package.json`. The version code is derived from it so every release upgrades the last:
`(major*10000 + minor*100 + patch)*1000` plus 100+n for alpha.n, 200+n for beta.n, 300+n for rc.n and 900 for a final release
(2.0.0-alpha.7 → 20000107). `android/release/` is git-ignored; attach the APK to the GitHub release.

## One-time setup (outside the repo)

Everything lives next to the repo in `D:\Development_Projects` (the script looks in the nearest parent folder that has `devtools\`;
override with the environment variables at the top of `build.ps1`):

| What | Where | How it was set up |
|---|---|---|
| JDK 17 (Temurin) | `devtools\jdk-17` | zip from adoptium.net (Bubblewrap requires 17) |
| Android SDK | `devtools\android-sdk` | command-line tools 14742923 (`commandlinetools-win-14742923_latest.zip`) unpacked into `android-sdk\cmdline-tools\latest`, then `sdkmanager --sdk_root=<sdk> --licenses` and `sdkmanager --sdk_root=<sdk> "build-tools;36.1.0" "platforms;android-36"` with `JAVA_HOME` set to the JDK. (Newer command-line tools replace `sdkmanager` with the "Android CLI", which doesn't install these.) |
| Bubblewrap | `devtools\bubblewrap` | `npm install @bubblewrap/cli@1.25.0` (with `@bubblewrap/core` pinned to the same version through `overrides`); its config is `%USERPROFILE%\.bubblewrap\config.json` pointing at the JDK and SDK. Only needed to regenerate the project. |
| Release key | `devkeys\iskra-android.keystore` (PKCS12, alias `iskra`) | `keytool -genkeypair -storetype PKCS12 -alias iskra -keyalg RSA -keysize 4096 -validity 10000` |
| Key password | `devkeys\iskra-android-keystore.txt` (`password=...` line) | generated; never commit either file |

Gradle itself (8.11.1) is downloaded by the wrapper into `%USERPROFILE%\.gradle` on the first build.

**Keep the keystore safe.** Updates must be signed with the same key, and `client/public/.well-known/assetlinks.json` holds its SHA-256
fingerprint (`keytool -list -v -keystore <keystore>`). If the fingerprint doesn't match, Android shows the app with a browser bar.

## Digital Asset Links

`client/public/.well-known/assetlinks.json` is served at https://app.iskra.foo/.well-known/assetlinks.json (Vite copies `public/`,
`public/_headers` gives it `application/json`). It proves the app and the site belong together, which removes the browser bar.
If the app is ever published on Google Play with Play App Signing, add Play's app-signing key fingerprint there too.

## Changing the app

Edit `twa-manifest.json` (name, colors, icons, splash fade, etc.), then regenerate:

```powershell
cd android
D:\Development_Projects\devtools\bubblewrap\node_modules\.bin\bubblewrap update --skipVersionUpgrade
```

Regenerating overwrites `app/build.gradle`: put back the two version lines that read `iskraVersionCode` / `iskraVersionName`
(see `git diff`). Icons and the splash are fetched from app.iskra.foo, so deploy icon changes to the site first.

Not done (needs the owner): a Google Play listing (developer account, store listing, Play App Signing).
