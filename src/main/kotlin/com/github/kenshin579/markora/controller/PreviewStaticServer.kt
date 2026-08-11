package com.github.kenshin579.markora.controller

import com.intellij.openapi.diagnostic.logger
import io.netty.channel.ChannelHandlerContext
import io.netty.handler.codec.http.EmptyHttpHeaders
import io.netty.handler.codec.http.FullHttpRequest
import io.netty.handler.codec.http.HttpMethod
import io.netty.handler.codec.http.HttpRequest
import io.netty.handler.codec.http.QueryStringDecoder
import org.jetbrains.ide.HttpRequestHandler

class PreviewStaticServer : HttpRequestHandler() {

    override fun isAccessible(request: HttpRequest): Boolean {
        return request.uri().startsWith(PREFIX)
    }

    override fun isSupported(request: FullHttpRequest): Boolean {
        // super.isSupported는 GET/HEAD만 허용 → POST 차단됨. 직접 체크로 교체.
        return request.uri().startsWith(PREFIX) &&
            (request.method() == HttpMethod.GET || request.method() == HttpMethod.POST)
    }

    override fun process(
        urlDecoder: QueryStringDecoder,
        request: FullHttpRequest,
        context: ChannelHandlerContext
    ): Boolean {
        val path = urlDecoder.path().removePrefix(PREFIX)
        LOG.info("Processing request: $path")

        return when {
            path.startsWith("api/file") ->
                MarkdownFileController.handle(urlDecoder, request, context)
            path.startsWith("api/upload") ->
                ImageUploadController.handle(urlDecoder, request, context)
            path.startsWith("api/local-image") ->
                LocalImageController.handle(urlDecoder, request, context)
            path.startsWith("api/vcs") ->
                VcsBaselineController.handle(urlDecoder, request, context)
            path.startsWith("resources/") ->
                ResourcesController.handle(path.removePrefix("resources/"), request, context, this)
            else -> false
        }
    }

    /**
     * 번들 리소스(JS/CSS/HTML/폰트/이미지)를 전송한다.
     * protected인 [HttpRequestHandler.sendData]를 ResourcesController에서 호출하기 위한 래퍼.
     * sendData가 Netty 버퍼를 내부적으로 처리하므로 플러그인 코드는 Unpooled/ByteBuf를 직접 쓰지 않는다.
     */
    internal fun sendResource(
        content: ByteArray,
        name: String,
        request: FullHttpRequest,
        context: ChannelHandlerContext
    ): Boolean = sendData(content, name, request, context.channel(), EmptyHttpHeaders.INSTANCE)

    companion object {
        const val PREFIX = "/markora/"
        private val LOG = logger<PreviewStaticServer>()

        fun getServiceUrl(): String {
            val port = org.jetbrains.ide.BuiltInServerManager.getInstance().port
            return "http://localhost:$port$PREFIX"
        }
    }
}
