import SwiftUI
import UIKit

/// Time picker stepping by 15 minutes; reads/writes `"HH:MM"` 24h to match workspace format.
struct QuarterHourTimePicker: UIViewRepresentable {
    @Binding var timeHHMM: String

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIDatePicker {
        let picker = UIDatePicker()
        picker.datePickerMode = .time
        picker.minuteInterval = 15
        picker.preferredDatePickerStyle = .wheels
        picker.addTarget(context.coordinator, action: #selector(Coordinator.valueChanged(_:)), for: .valueChanged)
        return picker
    }

    func updateUIView(_ uiView: UIDatePicker, context: Context) {
        context.coordinator.timeBinding = $timeHHMM
        guard let date = Self.dateForPicker(fromHHMM: timeHHMM) else { return }
        if abs(uiView.date.timeIntervalSince(date)) > 1 {
            uiView.setDate(date, animated: false)
        }
    }

    /// Snap to nearest 15 minutes (same calendar day).
    static func dateForPicker(fromHHMM s: String) -> Date? {
        let parts = s.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        var minutes = parts[0] * 60 + parts[1]
        minutes = min(23 * 60 + 45, max(0, (minutes + 7) / 15 * 15))
        return Calendar.current.date(
            bySettingHour: minutes / 60,
            minute: minutes % 60,
            second: 0,
            of: Date()
        )
    }

    final class Coordinator: NSObject {
        var timeBinding: Binding<String> = .constant("00:00")

        @objc func valueChanged(_ sender: UIDatePicker) {
            let c = Calendar.current.dateComponents([.hour, .minute], from: sender.date)
            let h = c.hour ?? 0
            let m = c.minute ?? 0
            timeBinding.wrappedValue = String(format: "%02d:%02d", h, m)
        }
    }
}

// MARK: - 1-minute resolution (settings / breaks)

/// Standard hour+minute picker for screens that are not constrained to scheduling blocks.
struct TimePickerField: View {
    @Binding var time: String
    @State private var date = Date()

    var body: some View {
        DatePicker("", selection: $date, displayedComponents: .hourAndMinute)
            .labelsHidden()
            .onChange(of: date) { _, new in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: new)
                time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
            }
            .onAppear {
                let parts = time.split(separator: ":").compactMap { Int($0) }
                if parts.count == 2,
                   let d = Calendar.current.date(
                    bySettingHour: parts[0], minute: parts[1], second: 0, of: Date()
                   ) {
                    date = d
                }
            }
    }
}
