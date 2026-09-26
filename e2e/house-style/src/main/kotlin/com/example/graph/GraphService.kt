package com.example.graph

import com.example.core.NotFoundException
import com.example.core.Page
import com.example.core.PageRequest
import com.example.models.ProbeResponse
import java.time.Instant

class GraphService : GraphApi {
    private val nodes = linkedMapOf<String, Node>()
    val actors = mutableListOf<String>()

    override suspend fun listNodes(kind: NodeKind?, page: PageRequest): Page<Node> {
        val matching = nodes.values.filter { kind == null || it.kind == kind }
        return Page(matching.drop(page.offset).take(page.limit), matching.size.toLong(), page.offset, page.limit)
    }

    override suspend fun createNode(request: CreateNodeRequest, actorId: String): Node {
        val node = Node(
            id = "n${nodes.size + 1}",
            kind = request.kind,
            name = request.name,
            createdAt = Instant.parse("2026-01-01T00:00:00Z"),
        )
        nodes[node.id] = node
        actors += actorId
        return node
    }

    override suspend fun readNode(id: String): Node = nodes[id] ?: throw NotFoundException("Node '$id' was not found")

    override suspend fun deleteNode(id: String, actorId: String) {
        nodes.remove(id) ?: throw NotFoundException("Node '$id' was not found")
        actors += actorId
    }

    override suspend fun probe(actorId: String): ProbeResponse = ProbeResponse(ok = true)
}
