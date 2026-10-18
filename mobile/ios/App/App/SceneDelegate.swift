import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = IskraViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // iskra://share (the Share Extension): the share waits in the App Group; the plugin hands it to the page.
        let shares = URLContexts.filter { $0.url.scheme == "iskra" && $0.url.host == "share" }
        if !shares.isEmpty { NotificationCenter.default.post(name: IskraNative.shareArrived, object: nil) }
        let rest = URLContexts.subtracting(shares)
        if !rest.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: rest) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
