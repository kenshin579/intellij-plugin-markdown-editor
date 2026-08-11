package com.github.kenshin579.markora.controller

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Computable
import com.intellij.openapi.vfs.LocalFileSystem
import io.netty.channel.ChannelHandlerContext
import io.netty.handler.codec.http.*
import org.jetbrains.ide.RestService

object MarkdownFileController {

    private val LOG = logger<MarkdownFileController>()

    fun handle(
        urlDecoder: QueryStringDecoder,
        request: FullHttpRequest,
        context: ChannelHandlerContext
    ): Boolean {
        val path = urlDecoder.path().removePrefix(PreviewStaticServer.PREFIX)

        return when {
            path == "api/file/read" && request.method() == HttpMethod.GET -> {
                handleRead(urlDecoder, request, context)
            }
            path == "api/file/save" && request.method() == HttpMethod.POST -> {
                handleSave(request, context)
            }
            else -> false
        }
    }

    private fun handleRead(
        urlDecoder: QueryStringDecoder,
        request: FullHttpRequest,
        context: ChannelHandlerContext
    ): Boolean {
        val filePath = urlDecoder.parameters()["path"]?.firstOrNull()
        if (filePath == null) {
            sendJsonResponse(request, context, HttpResponseStatus.BAD_REQUEST, """{"error":"Missing path parameter"}""")
            return true
        }

        val virtualFile = LocalFileSystem.getInstance().findFileByPath(filePath)
        if (virtualFile == null) {
            sendJsonResponse(request, context, HttpResponseStatus.NOT_FOUND, """{"error":"File not found"}""")
            return true
        }

        val content = ApplicationManager.getApplication().runReadAction(
            Computable {
                FileDocumentManager.getInstance().getDocument(virtualFile)?.text ?: ""
            }
        )

        val escapedContent = escapeJsonString(content)

        sendJsonResponse(request, context, HttpResponseStatus.OK, """{"content":"$escapedContent"}""")
        return true
    }

    private fun handleSave(request: FullHttpRequest, context: ChannelHandlerContext): Boolean {
        // request.content().toString(...) (Netty internal API) 대신 플랫폼 RestService의
        // JSON 리더를 사용해 요청 본문을 읽는다. {"path":"...","content":"..."}
        var filePath: String? = null
        var content: String? = null
        try {
            RestService.createJsonReader(request).use { reader ->
                reader.beginObject()
                while (reader.hasNext()) {
                    when (reader.nextName()) {
                        "path" -> filePath = reader.nextString()
                        "content" -> content = reader.nextString()
                        else -> reader.skipValue()
                    }
                }
                reader.endObject()
            }
        } catch (e: Exception) {
            LOG.warn("Failed to parse save request body", e)
            sendJsonResponse(request, context, HttpResponseStatus.BAD_REQUEST, """{"error":"Invalid request body"}""")
            return true
        }

        val resolvedPath = filePath
        val resolvedContent = content
        if (resolvedPath == null || resolvedContent == null) {
            sendJsonResponse(request, context, HttpResponseStatus.BAD_REQUEST, """{"error":"Invalid request body"}""")
            return true
        }

        val virtualFile = LocalFileSystem.getInstance().findFileByPath(resolvedPath)
        if (virtualFile == null) {
            sendJsonResponse(request, context, HttpResponseStatus.NOT_FOUND, """{"error":"File not found"}""")
            return true
        }

        val project = ProjectManager.getInstance().openProjects.firstOrNull()

        ApplicationManager.getApplication().invokeLater {
            WriteCommandAction.runWriteCommandAction(project) {
                val document = FileDocumentManager.getInstance().getDocument(virtualFile)
                document?.setText(resolvedContent)
            }
        }

        sendJsonResponse(request, context, HttpResponseStatus.OK, """{"success":true}""")
        return true
    }

    private fun sendJsonResponse(
        request: FullHttpRequest,
        context: ChannelHandlerContext,
        status: HttpResponseStatus,
        json: String
    ) {
        sendTextResponse(context.channel(), request, status, "application/json", json, cors = true)
    }
}
