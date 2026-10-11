import Capacitor
import UIKit

/// The web view's controller: Capacitor's, plus the app's own plugin (IskraNative).
class IskraViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(IskraNative())
    }
}
