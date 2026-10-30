// هيكل App Clip لـ «طلبك جاهز» (المرحلة الثانية). لم يُبنَ ولم يُختبر في هذه البيئة؛ يحتاج Xcode وحساب Apple Developer.
// الفكرة: مسح رمز QR بكاميرا الآيفون يعرض بطاقة App Clip، وبلمسة "فتح" يحصل الـ Clip على إذن إشعارات مؤقت (8 ساعات)
// دون نافذة طلب إذن، فيسجل رمز الجهاز لدى الخادم، ويصل إشعار الجاهزية بصوت واهتزاز مثل أي تطبيق.
// Info.plist المطلوب:
//   NSAppClip -> NSAppClipRequestEphemeralUserNotification = YES
//   Associated Domains -> appclips:YOUR_DOMAIN
import SwiftUI
import UserNotifications

let SERVER = "https://YOUR_DOMAIN"

final class AppDelegate: NSObject, UIApplicationDelegate {
    static var orderId: String?
    func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        guard let id = AppDelegate.orderId, let url = URL(string: "\(SERVER)/api/orders/\(id)/apns") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["token": hex])
        URLSession.shared.dataTask(with: req).resume()
    }
}

@main
struct TalabakClip: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @State private var number = "…"
    @State private var ephemeral = false
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Text("رقم طلبك").foregroundStyle(.secondary)
                Text(number).font(.system(size: 72, weight: .bold))
                Text(ephemeral ? "سيصلك تنبيه بصوت واهتزاز عند جاهزية طلبك. يمكنك إغلاق هذه الشاشة."
                               : "فعّل الإشعارات من بطاقة التطبيق ليصلك التنبيه.")
                    .multilineTextAlignment(.center).padding()
            }
            .environment(\.layoutDirection, .rightToLeft)
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                // رابط الاستدعاء هو نفسه رابط صفحة الويب: https://YOUR_DOMAIN/o/<id>
                guard let url = activity.webpageURL else { return }
                AppDelegate.orderId = url.lastPathComponent
                UNUserNotificationCenter.current().getNotificationSettings { s in
                    DispatchQueue.main.async {
                        ephemeral = (s.authorizationStatus == .ephemeral)
                        // لا نطلب إذنا صريحا؛ الإذن المؤقت يكفي ولا يُظهر أي نافذة
                        UIApplication.shared.registerForRemoteNotifications()
                    }
                }
                fetchNumber()
            }
        }
    }
    func fetchNumber() {
        guard let id = AppDelegate.orderId, let url = URL(string: "\(SERVER)/api/orders") else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data, let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                  let o = list.first(where: { $0["id"] as? String == id }) else { return }
            DispatchQueue.main.async { number = o["number"] as? String ?? "…" }
        }.resume()
    }
}
