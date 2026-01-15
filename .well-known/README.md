# Deep Link Configuration

This directory contains the configuration files for iOS Universal Links and Android App Links.

## Files

### assetlinks.json (Android App Links)
This file is used by Android to verify that your app can handle links from your domain.

**Important:** You need to replace `SHA256_CERT_FINGERPRINT_HERE` with your actual SHA-256 certificate fingerprint.

To get your SHA-256 fingerprint:

1. For debug builds:
```bash
cd android
./gradlew signingReport
```

2. For release builds (using your keystore):
```bash
keytool -list -v -keystore /path/to/your/keystore.jks -alias your_key_alias
```

Copy the SHA-256 fingerprint (without colons) and update `assetlinks.json`.

### apple-app-site-association (iOS Universal Links)
This file is used by iOS to verify that your app can handle links from your domain.

**Important:** You need to replace `TEAM_ID` with your actual Apple Developer Team ID.

To find your Team ID:
1. Go to https://developer.apple.com/account
2. Click on "Membership" in the sidebar
3. Copy your Team ID

Then update `apple-app-site-association` by replacing `TEAM_ID` with your actual Team ID (e.g., `ABC123XYZ.com.rexstream.app`).

## Verification

After deploying these files, verify they are accessible:

- Android: https://panel.rexstream.net/.well-known/assetlinks.json
- iOS: https://panel.rexstream.net/.well-known/apple-app-site-association

Both files must be served:
- Over HTTPS
- With status code 200
- With correct Content-Type (application/json)
- Without requiring authentication

## Testing

### Android
```bash
# Test the link
adb shell am start -a android.intent.action.VIEW -d "https://panel.rexstream.net/app/oauth-callback?platform=youtube&success=true"
```

### iOS
Use Safari to open the link: https://panel.rexstream.net/app/oauth-callback?platform=youtube&success=true

The app should open automatically if configured correctly.
