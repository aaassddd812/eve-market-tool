package __PACKAGE__

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

// 网页铺满全屏（状态栏 / 导航栏透明，网页背景延伸到下面），但安卓 WebView 不给网页报 env(safe-area-inset-*)，
// 所以这里把状态栏、导航栏高度（CSS 像素）交给网页：app-init.js 写到 <html> 的 --sa-top / --sa-bottom，顶栏、底部标签栏自己让开。
// 键盘弹出时内容区底部让出键盘高度（全屏模式下系统不再自动缩小 WebView）。状态栏图标颜色跟网页主题（EveApp.lightBars）。
class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  @Volatile private var top = 0f
  @Volatile private var bottom = 0f

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    @Suppress("DEPRECATION")
    window.statusBarColor = Color.TRANSPARENT
    @Suppress("DEPRECATION")
    window.navigationBarColor = Color.TRANSPARENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
    lightBars(false)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val d = resources.displayMetrics.density
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      v.setPadding(0, 0, 0, ime)
      top = bars.top / d
      bottom = if (ime > 0) 0f else bars.bottom / d
      push()
      insets
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "EveApp")
    push()
  }

  private fun push() {
    val w = webView ?: return
    w.post { w.evaluateJavascript("window.__eveInsets && window.__eveInsets($top, $bottom)", null) }
  }

  private fun lightBars(light: Boolean) {
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = light
      isAppearanceLightNavigationBars = light
    }
  }

  inner class Bridge {
    @JavascriptInterface fun top(): Float = top
    @JavascriptInterface fun bottom(): Float = bottom
    @JavascriptInterface fun lightBars(light: Boolean) { runOnUiThread { this@MainActivity.lightBars(light) } }
  }
}
