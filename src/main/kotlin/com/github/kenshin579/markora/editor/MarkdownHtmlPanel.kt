package com.github.kenshin579.markora.editor

import com.github.kenshin579.markora.controller.PreviewStaticServer
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.changes.ChangeListListener
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.IdeFrame
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLifeSpanHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import javax.swing.JComponent

class MarkdownHtmlPanel(
    private val project: Project,
    private val file: VirtualFile
) : Disposable {

    private val browser: JBCefBrowser = JBCefBrowser()
    private val jsQuery: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)

    val component: JComponent
        get() = browser.component

    init {
        setupHandlers()
        loadEditor()
        subscribeExternalChangeReload()
        subscribeVcsChange()
    }

    // IDE가 다시 활성화될 때(터미널/다른 앱에서 돌아옴) 디스크 상태가 외부에서 변경됐을 수
    // 있다. JCEF 임베드 브라우저는 JS 'focus' 이벤트를 안정적으로 받지 못하므로 IDE 측에서
    // 명시적으로 트리거한다.
    //   1) virtualFile.refresh(async)로 VFS↔Document 동기화
    //   2) 동기화 완료 후 JS의 window.markora.reloadFromDisk 호출
    private fun subscribeExternalChangeReload() {
        val connection = ApplicationManager.getApplication().messageBus.connect(this)
        connection.subscribe(ApplicationActivationListener.TOPIC, object : ApplicationActivationListener {
            override fun applicationActivated(ideFrame: IdeFrame) {
                file.refresh(/* async = */ true, /* recursive = */ false) {
                    // postRunnable은 VFS refresh 완료 후 실행됨. Document가 최신화된 시점에 JS reload 요청.
                    executeJavaScript(
                        "try { if (window.markora && typeof window.markora.reloadFromDisk === 'function') { window.markora.reloadFromDisk(); } } catch (e) { console.warn('reloadFromDisk failed', e); }"
                    )
                }
            }
        })
    }

    // 커밋 / 브랜치 전환 / stage 등으로 VCS 상태가 바뀌면 baseline이 달라진다.
    // ChangeListManager의 갱신 완료 시점에 JS로 알려 baseline을 다시 받게 한다.
    private fun subscribeVcsChange() {
        val connection = project.messageBus.connect(this)
        connection.subscribe(ChangeListListener.TOPIC, object : ChangeListListener {
            override fun changeListUpdateDone() {
                executeJavaScript(
                    "try { if (window.markora && typeof window.markora.vcsChanged === 'function') { window.markora.vcsChanged(); } } catch (e) { console.warn('vcsChanged failed', e); }"
                )
            }
        })
    }

    private fun setupHandlers() {
        // Handle external link clicks - open in system browser
        browser.jbCefClient.addRequestHandler(object : CefRequestHandlerAdapter() {
            override fun onBeforeBrowse(
                browser: CefBrowser?,
                frame: CefFrame?,
                request: CefRequest?,
                userGesture: Boolean,
                isRedirect: Boolean
            ): Boolean {
                val url = request?.url ?: return false
                // Allow internal navigation (data: URLs, about:blank, localhost)
                if (url.startsWith("data:") || url.startsWith("about:") ||
                    url.contains("localhost") || url.contains("127.0.0.1")) {
                    return false
                }
                // Open external URLs in system browser
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    BrowserUtil.browse(url)
                    return true
                }
                return false
            }
        }, browser.cefBrowser)

        // Prevent popup windows - open in system browser instead
        browser.jbCefClient.addLifeSpanHandler(object : CefLifeSpanHandlerAdapter() {
            override fun onBeforePopup(
                browser: CefBrowser?,
                frame: CefFrame?,
                targetUrl: String?,
                targetFrameName: String?
            ): Boolean {
                if (targetUrl != null && (targetUrl.startsWith("http://") || targetUrl.startsWith("https://"))) {
                    BrowserUtil.browse(targetUrl)
                }
                return true // Always cancel popup
            }
        }, browser.cefBrowser)
    }

    private fun loadEditor() {
        val serverUrl = PreviewStaticServer.getServiceUrl()
        val isDark = EditorColorsManager.getInstance().isDarkEditor
        val params = listOf(
            "filePath=" + java.net.URLEncoder.encode(file.path, Charsets.UTF_8),
            "serverUrl=" + java.net.URLEncoder.encode(serverUrl, Charsets.UTF_8),
            "dark=$isDark",
            "_t=${System.currentTimeMillis()}"
        ).joinToString("&")
        val url = "${serverUrl}resources/blocknote/dist/index.html?$params"
        browser.loadURL(url)
    }

    fun executeJavaScript(script: String) {
        browser.cefBrowser.executeJavaScript(script, null, 0)
    }

    override fun dispose() {
        jsQuery.dispose()
        browser.dispose()
    }

    companion object {
        private val LOG = logger<MarkdownHtmlPanel>()
    }
}
