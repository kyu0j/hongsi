package dev.kyuyoung.hongsi

import android.os.Bundle
import android.content.Intent
import android.webkit.WebView
import java.lang.ref.WeakReference
import dev.kyuyoung.hongsi.widget.WidgetNavigation
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override val handleBackNavigation: Boolean = true
  private var widgetWebView = WeakReference<WebView>(null)
  override fun onWebViewCreate(webView: WebView) { super.onWebViewCreate(webView); widgetWebView = WeakReference(webView) }
  private fun notifyWebView(event: String) { widgetWebView.get()?.evaluateJavascript("window.dispatchEvent(new Event('$event'))", null) }
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    WidgetNavigation.accept(intent)
    super.onNewIntent(intent)
    notifyWebView("hongsi-widget")
  }
  override fun onResume() {
    super.onResume()
    notifyWebView("hongsi-resume")
    notifyWebView("hongsi-widget")
  }
  override fun onPause() {
    notifyWebView("hongsi-pause")
    super.onPause()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    dev.kyuyoung.hongsi.widget.WidgetNative.prepare(applicationContext)
    enableEdgeToEdge()
    WidgetNavigation.accept(intent)
    super.onCreate(savedInstanceState)
  }
}
