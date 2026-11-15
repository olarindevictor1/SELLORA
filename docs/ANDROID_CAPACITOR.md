# SELLORA — Android Application Guide (Capacitor)

SELLORA includes `capacitor.config.ts` (`appId: com.sellora.store`, `appName: SELLORA`, `webDir: dist`) so the Android app shares the exact same frontend, backend API, Better Auth cookies/sessions, Nigerian checkout, Track Order, and database.

## 1. Prerequisites
- Android Studio & Android SDK installed locally
- Java 17+ (JDK)
- Built web assets (`npm run build`)

## 2. Generate Native Android Project & Sync
```bash
npm install @capacitor/android
npx cap add android
npm run build
npx cap sync android
```

## 3. Launcher Icons & Splash Screen
- Source icon: `public/icon.svg` and `public/pwa-512x512.png` (Navy `#172554` + Lime `#B7F36B`).
- Adaptive icon background color: `#172554`.
- SplashScreen configured in `capacitor.config.ts` (`backgroundColor: '#172554'`).
- To generate Android mipmap resources automatically:
  ```bash
  npx @capacitor/assets generate --android
  ```

## 4. Pointing Android App to Hosted Backend
In `capacitor.config.ts`, configure `server.url` to your deployed HTTPS SELLORA domain (or bundle `dist/` and set your API base URL) so cookies (`SameSite=Lax` / `Secure`), file uploads (receipts), and Better Auth sessions work cleanly over HTTPS.

## 5. Build Signed APK / AAB
```bash
npx cap open android
```
Use Android Studio **Build → Generate Signed Bundle / APK** to compile the release `.aab` or `.apk`. (No APK/AAB is generated inside the cloud sandbox; build locally with Android SDK.)
