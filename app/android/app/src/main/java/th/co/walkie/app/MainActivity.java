package th.co.walkie.app;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WalkiePlugin.class); // local plugin, must be registered before super.onCreate
        super.onCreate(savedInstanceState);
    }

    /**
     * While the app is on screen, hardware PTT keys reach the activity first.
     * Headset buttons with the screen off go through the service's MediaSession instead.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        WalkieService s = WalkieService.get();
        if (s != null && s.wantsKey(event.getKeyCode())) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) s.onHardKey(true);
            else if (event.getAction() == KeyEvent.ACTION_UP) s.onHardKey(false);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}
