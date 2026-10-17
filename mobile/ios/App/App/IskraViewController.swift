import Capacitor
import UIKit

/// The web view's controller: Capacitor's, plus the app's own plugin (IskraNative).
class IskraViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(IskraNative())
        // Sideways swipes belong to the page (they move the channel and member drawers), not to web view history.
        webView?.allowsBackForwardNavigationGestures = false
    }
}
