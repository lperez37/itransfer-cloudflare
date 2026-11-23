# Android testing deployment

Distribute signed release APKs through iTransfer for private Android testing. Create a new share with a seven-day expiry for each testing deployment.

1. Build from `android/` with `./gradlew :app:assembleRelease`. Use the persistent iTransfer signing key so both testers can install updates in place. Increment `versionCode` for a new build. [Signing setup](README.md#sign-sideload-builds)
2. Verify `app/build/outputs/apk/release/app-release.apk` with the Android SDK's `apksigner verify`. Copy it to `artifacts/iTransfer-<versionName>.apk` and upload that APK.
3. Use the iTransfer skill and the configured instance. Create a share with `POST /api/v1/shares`, `expiry_days: 7`, a random 20-character ID, and the APK's exact filename, byte size, and `application/vnd.android.package-archive` MIME type. Upload the APK bytes to the presigned R2 URL. For a single PUT, confirm the share only after R2 returns HTTP 200. If the API returns a multipart plan, finish the parts and complete multipart before confirming. [Share API](../docs/API.md#shares)
4. Verify the share is active and the public metadata is reachable with the seven-day expiry. Download the APK through the share and compare its SHA-256 with the local artifact. The verification download counts as one download.
5. Return the confirmed `share_url` and the server's expiry date and time to the user.
