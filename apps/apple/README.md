# Apple app

Open the existing `lou/lou.xcodeproj` in Xcode. The shared schemes build separate native apps:

| Scheme | Target | Destination | Bundle identifier | Minimum OS |
| --- | --- | --- | --- | --- |
| `lou-iOS` | `lou` (original target) | iPhone or iPad simulator/device | `com.ebantugan.lou` | iOS 26.5 |
| `lou-macOS` | `lou-macOS` | My Mac | `com.ebantugan.lou.macos` | macOS 26.5 |

Select the scheme and its destination, then Run. The original automatically generated `lou` scheme can also build the iOS target. Neither target depends on the other. The macOS app is native SwiftUI, with Mac Catalyst disabled on the iOS target.

## Code and assets

Both targets use the same filesystem-synchronized `lou/` source group, including `louApp.swift`, the SwiftData `Item` model, `ContentView.swift`, and `Assets.xcassets`. New models, services, networking, and reusable views in this group are automatically included in both targets. Keep shared logic here instead of copying files between targets.

`lou/Platform/NavigationViewWrapper.swift` isolates native navigation: `NavigationStack` on iOS and `NavigationSplitView` on macOS. The shared toolbar conditionally shows the iOS edit button. Put additional platform implementations under `lou/Platform/iOS/` or `lou/Platform/macOS/`, wrapping platform-only imports and declarations in `#if os(iOS)` or `#if os(macOS)` because both targets compile this synchronized group.

The existing shared AppIcon catalog retains its iOS and macOS slots, and both targets use the existing accent color. Icon artwork is still empty, as in the original project; supply artwork in these slots before distribution.

## Configuration and signing

`Configuration/Shared.xcconfig` holds common version, Swift, signing, generated Info.plist, and asset settings. `iOS.xcconfig` and `macOS.xcconfig` define the platform SDK, deployment version, bundle identifier, and platform-specific Info.plist settings for both Debug and Release. Deployment versions remain at the original project's 26.5.

Automatic signing retains the existing development team `MDG4K446L5`. For physical iOS devices or distribution, use an Xcode account with access to that team and provisioning profiles for the appropriate bundle identifier. Override `DEVELOPMENT_TEAM` when building with another team.

macOS enables the hardened runtime and App Sandbox with the existing read-only user-selected-file permission in `Configuration/macOS.entitlements`. SwiftData stores each app's data locally. No App Groups or iCloud capabilities are needed for the current functionality. If future shared networking makes outbound requests on macOS, add the sandbox's outgoing network client entitlement to that file.

iOS generates its scene manifest and launch screen and supports the existing phone/tablet orientations. macOS generates its own Info.plist with the productivity application category, without iOS-specific keys.

## Command-line builds

From the repository root:

```sh
xcodebuild -project apps/apple/lou/lou.xcodeproj -scheme lou-iOS \
  -configuration Debug -destination 'generic/platform=iOS Simulator' build
xcodebuild -project apps/apple/lou/lou.xcodeproj -scheme lou-macOS \
  -configuration Debug -destination 'platform=macOS' build
```

Use `-configuration Release` to verify release builds. A device build uses `-destination 'generic/platform=iOS'` and requires provisioning to sign for installation. Build-only validation without a provisioning profile can use `CODE_SIGNING_ALLOWED=NO`; such a device product cannot be installed until it is signed.
