package com.example.core

import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.createRouteScopedPlugin
import io.ktor.server.application.install
import io.ktor.server.auth.AuthenticationChecked
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.principal
import io.ktor.server.routing.Route
import io.ktor.server.routing.RouteSelector
import io.ktor.server.routing.RouteSelectorEvaluation
import io.ktor.server.routing.RoutingResolveContext
import java.time.Instant
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

// ── Wire types ──────────────────────────────────────────────────────────────

@Serializable
data class Page<T>(val items: List<T>, val total: Long, val offset: Int, val limit: Int)

object InstantSerializer : KSerializer<Instant> {
    override val descriptor = PrimitiveSerialDescriptor("IsoInstant", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())
    override fun deserialize(decoder: Decoder): Instant = Instant.parse(decoder.decodeString())
}

typealias IsoInstant = @Serializable(with = InstantSerializer::class) Instant

// ── Paging ──────────────────────────────────────────────────────────────────

data class PageRequest(val offset: Int, val limit: Int)

fun ApplicationCall.pageRequest(): PageRequest = PageRequest(
    offset = request.queryParameters["offset"]?.toInt() ?: 0,
    limit = request.queryParameters["limit"]?.toInt() ?: 50,
)

// ── Errors ──────────────────────────────────────────────────────────────────

class NotFoundException(message: String) : RuntimeException(message)

class ForbiddenException : RuntimeException("Insufficient permissions")

// ── Auth ────────────────────────────────────────────────────────────────────

const val JWT_AUTH = "house-auth"

@JvmInline
value class Permission(val value: String)

fun ApplicationCall.requirePrincipal(): UserIdPrincipal =
    principal<UserIdPrincipal>() ?: error("route is not authenticated")

private class PermissionSelector(val permission: Permission) : RouteSelector() {
    override suspend fun evaluate(context: RoutingResolveContext, segmentIndex: Int) = RouteSelectorEvaluation.Transparent
    override fun toString() = "(permission ${permission.value})"
}

private class PermissionConfig {
    var required: Permission? = null
}

/** Grants come from the `X-Permissions` header (a test stand-in for token claims). */
private val RequirePermission = createRouteScopedPlugin("RequirePermission", ::PermissionConfig) {
    val required = checkNotNull(pluginConfig.required)
    on(AuthenticationChecked) { call ->
        val granted = call.request.headers["X-Permissions"]?.split(",").orEmpty()
        if (required.value !in granted) throw ForbiddenException()
    }
}

fun Route.requirePermission(permission: Permission, build: Route.() -> Unit): Route {
    val route = createChild(PermissionSelector(permission))
    route.install(RequirePermission) { required = permission }
    route.build()
    return route
}
