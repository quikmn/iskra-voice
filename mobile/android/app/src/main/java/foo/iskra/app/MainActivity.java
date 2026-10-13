package foo.iskra.app;

import android.graphics.Color;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(IskraNativePlugin.class);
        super.onCreate(savedInstanceState);
        // Edge to edge on every Android version, as Android 15+ enforces anyway: the page draws behind the status and
        // navigation bars and keeps clear of them with the insets Capacitor's SystemBars hands it (--safe-area-inset-*).
        // Transparent bars, no scrim; the client picks light or dark icons for its theme (platform/native.ts).
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
    }
}
