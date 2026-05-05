// swift-tools-version: 5.9
// HomeboundHarmony iOS Worker App
//
// Setup in Xcode:
//   1. Create a new Xcode project: iOS > App, named "HomeboundHarmony",
//      interface: SwiftUI, lifecycle: SwiftUI App.
//   2. File > Add Package Dependencies → add CryptoSwift:
//      https://github.com/krzyzanowskim/CryptoSwift (from: "1.8.0")
//   3. Delete the generated ContentView.swift and copy the files from
//      Sources/HomeboundHarmony/ into the Xcode project target.
//   4. Set minimum deployment to iOS 17.0.
//   5. In Info.plist add NSLocationWhenInUseUsageDescription and
//      NSUserNotificationsUsageDescription.

import PackageDescription

let package = Package(
    name: "HomeboundHarmony",
    platforms: [
        .iOS(.v17),
    ],
    products: [
        .library(name: "HomeboundHarmony", targets: ["HomeboundHarmony"]),
    ],
    dependencies: [
        .package(url: "https://github.com/krzyzanowskim/CryptoSwift.git", from: "1.8.0"),
    ],
    targets: [
        .target(
            name: "HomeboundHarmony",
            dependencies: [
                .product(name: "CryptoSwift", package: "CryptoSwift"),
            ],
            path: "Sources/HomeboundHarmony"
        ),
    ]
)
