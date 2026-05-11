import SwiftUI

struct SignaturePadView: View {
    var onSign: (String) -> Void
    var onCancel: () -> Void

    @State private var strokes: [[CGPoint]] = []
    @State private var currentStroke: [CGPoint] = []

    private var allPoints: [[CGPoint]] {
        currentStroke.isEmpty ? strokes : strokes + [currentStroke]
    }

    private var isEmpty: Bool {
        strokes.isEmpty && currentStroke.isEmpty
    }

    var body: some View {
        VStack(spacing: 12) {
            Text("Sign below")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Canvas { context, size in
                for stroke in allPoints {
                    guard stroke.count >= 2 else { continue }
                    var path = Path()
                    path.move(to: stroke[0])
                    for pt in stroke.dropFirst() {
                        path.addLine(to: pt)
                    }
                    context.stroke(path, with: .color(.primary), lineWidth: 2.5)
                }
            }
            .frame(minHeight: 160)
            .background(Color(.systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
            )
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        currentStroke.append(value.location)
                    }
                    .onEnded { _ in
                        if !currentStroke.isEmpty {
                            strokes.append(currentStroke)
                            currentStroke = []
                        }
                    }
            )

            HStack {
                Button("Cancel") { onCancel() }
                    .foregroundStyle(.secondary)

                Spacer()

                Button("Clear") {
                    strokes = []
                    currentStroke = []
                }
                .foregroundStyle(.secondary)
                .disabled(isEmpty)

                Button("Done") {
                    onSign(buildSvgPath())
                }
                .fontWeight(.semibold)
                .disabled(isEmpty)
            }
        }
        .padding()
    }

    private func buildSvgPath() -> String {
        allPoints.map { stroke in
            guard let first = stroke.first else { return "" }
            let start = "M \(fmt(first.x)),\(fmt(first.y))"
            let lines = stroke.dropFirst().map { "L \(fmt($0.x)),\(fmt($0.y))" }
            return ([start] + lines).joined(separator: " ")
        }
        .filter { !$0.isEmpty }
        .joined(separator: " ")
    }

    private func fmt(_ v: CGFloat) -> String {
        String(format: "%.1f", v)
    }
}
