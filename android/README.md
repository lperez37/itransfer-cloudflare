# iTransfer for Android

The native iTransfer app uses Kotlin and Jetpack Compose. Each APK connects to the iTransfer server chosen at build time. Install the signed APK from your instance administrator, or build one for your own deployment. [Server setup guide](../docs/INSTALLATION.md) · [Android screenshots](../README.md#android-app)

The app remembers sign-in across restarts and APK updates. It encrypts the session with Android Keystore and uses the server’s session lifetime, configured for 90 days in this repository. Signing out or invalidating a session on the server ends that sign-in.

## Install and share

1. Open the signed release APK on an Android 8.0 or later device. If prompted, allow APK installation from the app that opened the file.
2. Sign in to iTransfer. You can also start in Files, Photos, or another app and choose **iTransfer** from the Android Sharesheet. Any incoming items stay in the draft while you sign in.
3. Review the files, choose an expiry and link format, then tap **Create share**. Both share and request forms default to a seven-day animal-name link. Switch to **Random** to choose the length of a letters-and-numbers link. Choose a preset such as **5 minutes** or enter a custom duration.
4. Copy the confirmed link or send it using the Android Sharesheet. Open **Shares** to find links again.

The app can pick several documents, accept shared files and turn shared text into a text file. It streams large files in multipart uploads with progress and retry. Drafts and transfers stay in memory across screen rotation. If Android ends the app process, start the share again.

## Shares and requests

- At the top of **Shares** or **Requests**, pull down and release to refresh the list. The spinner stays visible while the app checks for updates.
- In **Shares**, open a transfer to see its files and download history, save a file or a ZIP, hide or unhide the link, and change its expiry. On creation you can choose a password, a download limit, and a random or animal-name link.
- In **Requests**, create a link for someone to upload files, set size and upload limits, and allow repeat uploads. Open a request to see and download the files received or update its expiry.
- Open a transfer’s three-dot menu and choose **Delete permanently**, then confirm to remove the transfer, its files, and its history. To select several transfers, press and hold the first one, then tap the others. The selection bar has actions for the selected transfers.
- Use **Open link** to open a recipient share or request in the app. Protected shares can be unlocked and saved. File requests accept uploads with an optional message. The recipient screens use the same ten translations as the website.
- The account screen includes password changes and email preferences. Admins can manage users, read the audit log and cost reports, and visit another user's workspace with read-only or confirmed management access.

## Build locally

Use JDK 17 or later and an Android SDK with platform 36 and Build Tools 35.0.0. Set `ANDROID_HOME` to your SDK directory or configure `sdk.dir` in `local.properties`. From the repository root, run `cd android` before using the Gradle commands below. You can also open that directory in Android Studio.

In that directory, create `itransfer.local` and set `serverOrigin` to your deployment’s HTTPS origin. Add `publicLinkAliases` if your instance also serves links at other hostnames. Git ignores this file. You can also pass these settings as Gradle properties `itransfer.serverOrigin` and `itransfer.publicLinkAliases`.

```properties
serverOrigin=https://itransfer.example.test
publicLinkAliases=files.example.test
```

```bash
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The debug APK lives at `app/build/outputs/apk/debug/app-debug.apk`. An isolated test Worker can be selected with `-Pitransfer.debugOrigin=http://10.0.2.2:14587`. Debug cleartext is restricted to emulator and loopback test hosts. The release origin is fixed to the production HTTPS host.

## Sign sideload builds

Use one persistent, app-specific signing key for updates. Provide `signing.properties` in the ignored `.signing/` directory or in the directory configured with `ITRANSFER_SIGNING_DIR`. Set these entries using your keystore details.

```properties
storeFile=itransfer-release.p12
storePassword=YOUR_STORE_PASSWORD
keyAlias=itransfer
keyPassword=YOUR_KEY_PASSWORD
```

```bash
./gradlew :app:assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

The signing key stays with the maintainer. Share only the APK. The APK signing certificate must match on subsequent updates. Increase `versionCode` when packaging a new release. [Android app signing](https://developer.android.com/studio/publish/app-signing)

Private testing releases use a seven-day iTransfer link. [Testing deployment](AGENTS.md)

## Design

The app follows Android’s light and dark appearance. A cobalt paper plane marks outgoing shares and a jade envelope marks incoming requests. Compact transfer rows show file counts, status, and expiry together.
