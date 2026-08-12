package com.github.kenshin579.markora.controller

import io.netty.channel.Channel
import io.netty.handler.codec.http.FullHttpRequest
import io.netty.handler.codec.http.HttpHeaderNames
import io.netty.handler.codec.http.HttpResponseStatus
import org.jetbrains.io.response
import org.jetbrains.io.send
import java.nio.charset.StandardCharsets

/**
 * 텍스트(JSON/HTML/plain) 응답을 보내는 공통 헬퍼.
 *
 * `org.jetbrains.io.response`/`send`를 사용해 Netty 버퍼(`Unpooled`/`ByteBuf`)를
 * 직접 다루지 않는다 — 플랫폼이 internal로 표시한 API 사용을 피하기 위함.
 * content-length·keep-alive·보안 헤더는 `send`가 자동으로 채운다.
 */
internal fun sendTextResponse(
    channel: Channel,
    request: FullHttpRequest?,
    status: HttpResponseStatus,
    contentType: String,
    body: String,
    cors: Boolean = false,
) {
    val resp = response(body, StandardCharsets.UTF_8)
    resp.status = status
    resp.headers().set(HttpHeaderNames.CONTENT_TYPE, "$contentType; charset=UTF-8")
    if (cors) {
        resp.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    }
    resp.send(channel, request)
}

/**
 * 문자열을 JSON 문자열 리터럴 내부에 넣을 수 있게 이스케이프한다(따옴표는 포함하지 않는다).
 * `\n`/`\r`/`\t` 외의 제어문자도 `\uXXXX`로 처리해 잘못된 JSON 생성을 막는다.
 */
internal fun escapeJsonString(raw: String): String {
    val sb = StringBuilder(raw.length + 16)
    for (ch in raw) {
        when (ch) {
            '\\' -> sb.append("\\\\")
            '"' -> sb.append("\\\"")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> if (ch < ' ') sb.append(String.format("\\u%04x", ch.code)) else sb.append(ch)
        }
    }
    return sb.toString()
}
