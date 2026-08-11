package com.github.kenshin579.markora.controller

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Computable
import com.intellij.openapi.vcs.ProjectLevelVcsManager
import com.intellij.openapi.vcs.changes.ChangeListManager
import com.intellij.openapi.vcs.changes.ContentRevision
import com.intellij.openapi.vfs.LocalFileSystem
import io.netty.channel.ChannelHandlerContext
import io.netty.handler.codec.http.FullHttpRequest
import io.netty.handler.codec.http.HttpMethod
import io.netty.handler.codec.http.HttpResponseStatus
import io.netty.handler.codec.http.QueryStringDecoder

/**
 * 현재 파일의 VCS baseline(HEAD) 본문을 반환한다.
 *
 * 프론트는 이 본문을 현재 문서와 동일한 파싱 파이프라인에 통과시켜 블록 단위로 비교한다.
 * 라인 범위(LineStatusTracker)가 아니라 원문을 넘기는 이유는 설계 문서 참조.
 */
object VcsBaselineController {

    private val LOG = logger<VcsBaselineController>()

    private const val UNAVAILABLE = """{"status":"unavailable","content":null}"""
    private const val UNTRACKED = """{"status":"untracked","content":null}"""

    // read action 안에서는 '무엇을 읽을지'만 정한다. 실제 본문 로딩(느린 연산)은 밖에서 한다.
    private sealed interface Plan {
        object Unavailable : Plan
        object Untracked : Plan
        data class Inline(val status: String, val text: String) : Plan
        data class FromRevision(val revision: ContentRevision) : Plan
    }

    fun handle(
        urlDecoder: QueryStringDecoder,
        request: FullHttpRequest,
        context: ChannelHandlerContext
    ): Boolean {
        val path = urlDecoder.path().removePrefix(PreviewStaticServer.PREFIX)
        if (path != "api/vcs/baseline" || request.method() != HttpMethod.GET) return false

        val filePath = urlDecoder.parameters()["path"]?.firstOrNull()
        if (filePath == null) {
            send(request, context, HttpResponseStatus.BAD_REQUEST, """{"error":"Missing path parameter"}""")
            return true
        }

        val json = try {
            resolve(filePath)
        } catch (e: Exception) {
            // VcsException 등 — 마커를 못 그릴 뿐이므로 조용히 unavailable로 응답한다.
            LOG.warn("VCS baseline lookup failed for $filePath", e)
            UNAVAILABLE
        }
        send(request, context, HttpResponseStatus.OK, json)
        return true
    }

    private fun resolve(filePath: String): String {
        val virtualFile = LocalFileSystem.getInstance().findFileByPath(filePath) ?: return UNAVAILABLE
        val project = ProjectManager.getInstance().openProjects.firstOrNull() ?: return UNAVAILABLE

        val plan = ApplicationManager.getApplication().runReadAction(
            Computable {
                if (ProjectLevelVcsManager.getInstance(project).getVcsFor(virtualFile) == null) {
                    return@Computable Plan.Unavailable
                }
                val change = ChangeListManager.getInstance(project).getChange(virtualFile)
                val beforeRevision = change?.beforeRevision
                when {
                    // VCS 하위이지만 변경 없음 → 디스크 본문이 곧 HEAD 본문이다.
                    change == null -> {
                        val text = FileDocumentManager.getInstance().getDocument(virtualFile)?.text ?: ""
                        Plan.Inline("unchanged", text)
                    }
                    // 신규 파일 — 비교 대상이 없다. IDE도 이 경우 gutter 마커를 그리지 않는다.
                    beforeRevision == null -> Plan.Untracked
                    else -> Plan.FromRevision(beforeRevision)
                }
            }
        )

        return when (plan) {
            is Plan.Unavailable -> UNAVAILABLE
            is Plan.Untracked -> UNTRACKED
            is Plan.Inline -> """{"status":"${plan.status}","content":"${escapeJsonString(plan.text)}"}"""
            is Plan.FromRevision -> {
                val text = plan.revision.content ?: return UNAVAILABLE
                """{"status":"changed","content":"${escapeJsonString(text)}"}"""
            }
        }
    }

    private fun send(
        request: FullHttpRequest,
        context: ChannelHandlerContext,
        status: HttpResponseStatus,
        json: String
    ) {
        sendTextResponse(context.channel(), request, status, "application/json", json, cors = true)
    }
}
