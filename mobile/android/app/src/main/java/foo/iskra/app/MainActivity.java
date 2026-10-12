package foo.iskra.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(IskraNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
