package com.example.graph

import com.example.core.Permission
import io.ktor.server.routing.Route

object GraphModule {
    val READ = Permission("graph:read")
    val WRITE = Permission("graph:write")

    fun Route.mount(service: GraphApi) = graphRoutes(service)

    fun Route.mountUnmanaged(service: GraphApi) = graphUnmanagedRoutes(service)
}
