// swift-tools-version: 5.9
// Shared app logic for RouteCare lives under Sources/HomeboundHarmony/.
// The shipping iOS app target is `RouteCare` in RouteCare/RouteCare.xcodeproj (build via `ios/build.sh` or Xcode).

import PackageDescription

let package = Package(
    name: "HomeboundHarmony",
    platforms: [
        .iOS(.v17),
    ],
    products: [
        .library(name: "HomeboundHarmony", targets: ["HomeboundHarmony"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "HomeboundHarmony",
            dependencies: [],
            path: "Sources/HomeboundHarmony"
        ),
    ]
)
