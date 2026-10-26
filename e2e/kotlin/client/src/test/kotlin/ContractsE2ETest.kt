package com.example.contracts

import com.example.contracts.client.ContractsApiClient
import com.example.contracts.client.contractsDefaults
import com.example.contracts.api.BundleException
import com.example.contracts.api.LinesMetadataResult
import com.example.contracts.api.EventsMetadataResult
import com.example.contracts.api.UpdatesResult
import com.example.contracts.api.MixedStreamResult
import com.example.contracts.models.PetUpdates
import com.example.contracts.models.Specialized
import com.example.contracts.models.OutcomeInt32
import com.example.contracts.models.SseMessage
import com.example.contracts.models.Code
import com.example.contracts.models.DerivedNumbers
import com.example.contracts.models.EncodedPage
import com.example.contracts.models.ExactNumbers
import com.example.contracts.models.CompleteNumbers
import com.example.contracts.models.EncodedValues
import com.example.contracts.models.EncodedPrimitives
import com.example.contracts.models.ExactLiteral
import com.example.contracts.models.ExactDefaults
import com.example.contracts.models.NullableExtras
import com.example.contracts.models.ConstrainedExtras
import com.example.contracts.models.Serializer
import com.example.contracts.models.AAA
import com.example.contracts.models.Box
import com.example.contracts.models.Bundle
import com.example.contracts.models.StreamInput
import com.example.contracts.server.StreamInputPart
import com.example.contracts.models.AnimalHolder
import com.example.contracts.models.Cat
import com.example.contracts.models.Counter
import com.example.contracts.models.CounterEncoding
import com.example.contracts.models.NestedDefault
import com.example.contracts.models.NestedResult
import com.example.contracts.models.StrictOptional
import com.example.contracts.models.StrictOuter
import com.example.contracts.models.MixedBundleResponseMultipart
import com.example.contracts.models.GenericCodecs
import com.example.contracts.models.OptionalValue
import com.example.contracts.models.ContractsOperationsUploadTupleMultipart
import com.example.contracts.models.ContractsOperationsUploadMixedMultipart
import com.example.contracts.models.ContractsOperationsUploadRepeatedMultipart
import com.example.contracts.models.Geometry
import com.example.contracts.models.GeometryMetadata
import com.example.contracts.models.GeometryPoint
import com.example.contracts.models.HttpFile
import com.example.contracts.models.Mixed
import com.example.contracts.models.HugeCode
import com.example.contracts.models.Numbers
import com.example.contracts.models.OpenModel
import com.example.contracts.models.Page
import com.example.contracts.models.Pet
import com.example.contracts.models.Probe
import com.example.contracts.models.Settings
import com.example.contracts.models.State
import com.example.contracts.models.Validated
import com.example.contracts.models.WireEnvelope
import com.example.contracts.server.OperationsService
import com.example.contracts.server.SecuredService
import com.example.contracts.server.contractsModule
import io.ktor.server.testing.testApplication
import io.ktor.server.application.install
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.hooks.ResponseSent
import io.ktor.server.request.path
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.AuthenticationFailedCause
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.basic
import io.ktor.server.auth.bearer
import io.ktor.server.response.respond
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.request.header
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.ktor.websocket.send

class ContractsE2ETest {
    private val json = Json

    @Test
    fun complexTemplatesRetainConcreteTupleAndUnionCodecs() {
        val wire = """{"number":{"value":7,"pair":[7,"n"]},"text":{"value":"hello","pair":["hello","t"]},"outcome":{"reason":"failed"}}"""
        val value = json.decodeFromString<Specialized>(wire)
        assertEquals(7, value.number.pair.item1)
        assertEquals("hello", value.text.value)
        assertEquals("failed", kotlin.test.assertIs<OutcomeInt32.Failure>(value.outcome).value.reason)
        assertEquals(wire, json.encodeToString(value))
        assertFailsWith<SerializationException> { json.decodeFromString<Specialized>(wire.replace("[7,\"n\"]", "[7]")) }
    }

    @Test
    fun decimalNumbersAndBoundsKeepTheirExactContract() {
        val amount = java.math.BigDecimal("12345678901234567890.1234567890123456789")
        val count = java.math.BigInteger("123456789012345678901234567890")
        val fraction = java.math.BigDecimal("0.1234567890123456789012344")
        val date = java.time.Instant.parse("2025-01-01T00:00:00Z")
        val value = CompleteNumbers(amount, amount, listOf(count), fraction, date)
        val wire = """{"value":$amount,"text":"$amount","values":[$count],"fraction":$fraction,"date":"$date"}"""
        assertEquals(wire, json.encodeToString(value))
        assertEquals(value, json.decodeFromString<CompleteNumbers>(wire))
        assertFailsWith<IllegalArgumentException> { value.copy(values = listOf(count - java.math.BigInteger.ONE)) }
        assertFailsWith<IllegalArgumentException> { value.copy(fraction = java.math.BigDecimal("0.1234567890123456789012345")) }
        assertFailsWith<IllegalArgumentException> { value.copy(date = date.minusSeconds(1)) }
    }

    @Test
    fun strictOptionalsDistinguishAbsenceAndRejectNonNullableNulls() {
        assertEquals(StrictOptional(), json.decodeFromString<StrictOptional>("{}"))
        assertEquals("{}", json.encodeToString(StrictOptional()))
        assertEquals(StrictOptional(maybe = OptionalValue.Present(null)), json.decodeFromString<StrictOptional>("""{"maybe":null}"""))
        assertFailsWith<SerializationException> { json.decodeFromString<StrictOptional>("""{"label":null}""") }
        assertFailsWith<SerializationException> { json.decodeFromString<StrictOptional>("""{"nested":null}""") }
        assertEquals(OptionalValue.Present("ok"), StrictOuter().settings.label)
    }

    @Test
    fun codecsComposeWithPolymorphismReservedNamesAndEncodedValueClasses() {
        val reserved = com.example.contracts.models.JsonObject("x", mapOf("extra" to JsonPrimitive(1)))
        assertEquals(reserved, json.decodeFromString<com.example.contracts.models.JsonObject>(json.encodeToString(reserved)))
        val animal = AnimalHolder(Cat("Milo", mapOf("lives" to JsonPrimitive(9))))
        assertEquals(animal, json.decodeFromString<AnimalHolder>(json.encodeToString(animal)))
        val count = CounterEncoding(Counter(java.math.BigInteger("123456789012345678901234567890")))
        assertEquals("""{"value":"123456789012345678901234567890"}""", json.encodeToString(count))
        assertEquals(count, json.decodeFromString<CounterEncoding>(json.encodeToString(count)))
    }

    @Test
    fun nestedDefaultsRetainExactNumbersUnionConstructorsAndLogicalDates() {
        assertEquals(NestedResult.First("x"), NestedDefault().result)
        assertEquals(Cat("Milo"), NestedDefault().animal)
        val value = ExactDefaults()
        assertEquals(HugeCode.EXACT, value.code)
        assertEquals(java.math.BigInteger("123456789012345678901234567890"), value.counts.single())
        assertEquals(java.math.BigDecimal("12345678901234567890.1234567890123456789"), value.byName["exact"])
        assertEquals(WireEnvelope.Pet(Pet("Milo")), value.pet)
        assertEquals(java.time.Instant.parse("2025-01-01T00:00:00Z"), value.date)
        assertEquals(value, json.decodeFromString<ExactDefaults>("{}"))
    }

    @Test
    fun primitiveAndDelimitedEncodingsPreserveWireKinds() {
        val value = EncodedPrimitives(true, 42, listOf("a", "b"), listOf(1, 2))
        val wire = """{"enabled":"true","count":"42","tags":"a|b","numbers":"1,2"}"""
        assertEquals(value, json.decodeFromString<EncodedPrimitives>(wire))
        assertEquals(wire, json.encodeToString(value))
        assertEquals(value, json.decodeFromString<EncodedPrimitives>(wire.replace("true", "TRUE")))
        assertFailsWith<SerializationException> { json.encodeToString(value.copy(tags = listOf("a|b"))) }
    }

    @Test
    fun wireEncodingsKeepDatesAndFractionalDurations() {
        val instant = java.time.Instant.parse("2025-01-01T00:00:00Z")
        val value = EncodedValues(instant, instant, instant, listOf(java.time.Duration.ofMillis(1250)), java.time.Duration.ofMillis(1500), instant)
        val wire = """{"date":"Wed, 01 Jan 2025 00:00:00 GMT","epoch":1735689600,"reset":"2025-01-01T00:00:00Z","values":[1.25],"elapsed":1500,"standard":1735689600}"""
        assertEquals(Json.parseToJsonElement(wire), Json.parseToJsonElement(json.encodeToString(value)))
        assertEquals(value, json.decodeFromString<EncodedValues>(wire))
        assertFailsWith<SerializationException> { json.decodeFromString<EncodedValues>(wire.replace("1500", "1500.5")) }
        assertFailsWith<SerializationException> { json.decodeFromString<EncodedValues>(wire.replace("\"epoch\":1735689600", "\"epoch\":\"1735689600\"")) }
    }

    @Test
    fun codecsRetainNullPoliciesNamesDefaultsAndEncodedNestedArguments() {
        val implicitNulls = Json { explicitNulls = false }
        assertEquals(NullableExtras(null), implicitNulls.decodeFromString<NullableExtras>("{}"))
        assertEquals("{}", implicitNulls.encodeToString(NullableExtras(null)))
        val serializer = Serializer("known", mapOf("extra" to "kept"))
        assertEquals(serializer, json.decodeFromString<Serializer>(json.encodeToString(serializer)))
        assertEquals(JsonPrimitive(1), AAA().value.additionalProperties["extra"])
        assertFailsWith<IllegalArgumentException> { ConstrainedExtras(mapOf("bad" to "x")) }
        val literalWire = """{"value":123456789012345678901234567890}"""
        val literal = json.decodeFromString<ExactLiteral>(literalWire)
        assertEquals(literalWire, json.encodeToString(literal))
        val generic = GenericCodecs(listOf(Box(9007199254740993L)), OptionalValue.Present(Box(42L)))
        val genericWire = """{"boxes":[{"value":"9007199254740993"}],"optional":{"value":"42"}}"""
        assertEquals(Json.parseToJsonElement(genericWire), Json.parseToJsonElement(json.encodeToString(generic)))
        assertEquals(generic, json.decodeFromString<GenericCodecs>(genericWire))
    }

    @Test
    fun unboundedNumbersKeepExactValuesAndRejectWrongJsonKinds() {
        val count = java.math.BigInteger("1234567890123456789012345678901234567890")
        val exact = java.math.BigDecimal("12345678901234567890.1234567890123456789")
        val value = ExactNumbers(count, exact, count)
        val wire = """{"count":$count,"exact":$exact,"external":"$count"}"""
        assertEquals(value, json.decodeFromString<ExactNumbers>(wire))
        assertEquals(Json.parseToJsonElement(wire), Json.parseToJsonElement(json.encodeToString(value)))
        assertFailsWith<SerializationException> { json.decodeFromString<ExactNumbers>(wire.replace("\"count\":$count", "\"count\":1.5")) }
        assertFailsWith<SerializationException> { json.decodeFromString<ExactNumbers>(wire.replace("\"count\":$count", "\"count\":\"$count\"")) }
    }

    @Test
    fun additionalPropertiesKeepUnknownValuesAndRejectCollisions() {
        val wire = """{"display_name":"example","count":7,"nested":{"ok":true},"empty":null}"""
        val value = json.decodeFromString<OpenModel>(wire)
        assertEquals("example", value.name)
        assertEquals(JsonPrimitive(7), value.additionalProperties["count"])
        assertEquals(Json.parseToJsonElement(wire), Json.parseToJsonElement(json.encodeToString(value)))
        assertFailsWith<SerializationException> {
            json.encodeToString(OpenModel("example", mapOf("display_name" to JsonPrimitive("shadow"))))
        }
        assertEquals(Numbers(1, mapOf("extra" to 2)), json.decodeFromString<Numbers>("""{"count":1,"extra":2}"""))
        val derived = DerivedNumbers(1, 2, mapOf("extra" to 3))
        assertEquals(derived, json.decodeFromString<DerivedNumbers>(json.encodeToString(derived)))
        assertFailsWith<SerializationException> { json.decodeFromString<Numbers>("""{"count":1,"extra":"two"}""") }
    }

    @Test
    fun enumsPreservePrimitiveKindsAndExtensibleValues() {
        assertEquals("123456789012345678901234567890", json.encodeToString(HugeCode.EXACT))
        assertEquals(HugeCode.EXACT, json.decodeFromString<HugeCode>("123456789012345678901234567890"))
        assertEquals("1", json.encodeToString(Code.OK))
        assertEquals(Code.OK, json.decodeFromString<Code>("1"))
        assertFailsWith<SerializationException> { json.decodeFromString<Code>("\"1\"") }
        assertFailsWith<SerializationException> { json.decodeFromString<Code>("99") }
        assertEquals("\"auto\"", json.encodeToString(Mixed.AUTOMATIC))
        assertEquals("3", json.encodeToString(Mixed.COUNT))
        assertEquals(Code.FAILED, Code.fromWire("2"))
        assertEquals(State.READY, json.decodeFromString<State>("\"ready\""))
        assertEquals("\"future\"", json.encodeToString(State("future")))
    }

    @Test
    fun tupleCodecsKeepPositionsAndRejectWrongLengthsAndTypes() {
        val value = Geometry(GeometryPoint(1.5, 2.5), GeometryMetadata("a", 7, true))
        val wire = """{"point":[1.5,2.5],"metadata":["a",7,true]}"""
        assertEquals(Json.parseToJsonElement(wire), Json.parseToJsonElement(json.encodeToString(value)))
        assertEquals(value, json.decodeFromString<Geometry>(wire))
        assertFailsWith<SerializationException> { json.decodeFromString<GeometryPoint>("[1]") }
        assertFailsWith<SerializationException> { json.decodeFromString<GeometryPoint>("[1,2,3]") }
        assertFailsWith<SerializationException> { json.decodeFromString<GeometryPoint>("[1,\"bad\"]") }
    }

    @Test
    fun envelopesRetainDiscriminatorsAndPayloadShape() {
        val value: WireEnvelope = WireEnvelope.Pet(Pet("Milo"))
        val wire = """{"kind":"pet","payload":{"name":"Milo"}}"""
        assertEquals(Json.parseToJsonElement(wire), Json.parseToJsonElement(json.encodeToString(value)))
        assertEquals(value, json.decodeFromString<WireEnvelope>(wire))
        assertEquals(WireEnvelope.Message("hello"), json.decodeFromString<WireEnvelope>("""{"kind":"message","payload":"hello"}"""))
        assertFailsWith<SerializationException> { json.decodeFromString<WireEnvelope>("""{"kind":"other","payload":{}}""") }
        assertFailsWith<SerializationException> { json.decodeFromString<WireEnvelope>("""{"kind":"pet"}""") }
    }

    @Test
    fun genericModelPropertiesKeepStringEncodedArguments() {
        val value = EncodedPage(Page(listOf(9007199254740993L)))
        val wire = """{"page":{"items":["9007199254740993"]}}"""
        assertEquals(Json.parseToJsonElement(wire), Json.parseToJsonElement(json.encodeToString(value)))
        assertEquals(value, json.decodeFromString<EncodedPage>(wire))
    }

    @Test
    fun constructorsApplyDefaultsAndValidateLiteralsAndScalarCollections() {
        val settings = Settings("settings", 2)
        assertEquals(listOf("a", "b"), settings.tags)
        assertEquals(true, settings.config.enabled)
        assertEquals(mapOf("region" to "east"), settings.labels)
        assertEquals(settings, json.decodeFromString<Settings>("""{"kind":"settings","version":2}"""))
        assertFailsWith<IllegalArgumentException> { Settings("other", 2) }
        assertFailsWith<IllegalArgumentException> { Settings("settings", 3) }
        assertEquals(Validated(listOf("ab")), json.decodeFromString<Validated>("""{"names":["ab"]}"""))
        assertFailsWith<IllegalArgumentException> { Validated(listOf("a")) }
        assertFailsWith<IllegalArgumentException> { Validated(listOf("A!")) }
    }

    @Test
    fun generatedClientAndServerRoundTripContracts() = testApplication {
        var rejectedSocketStatus: HttpStatusCode? = null
        application {
            install(createApplicationPlugin("RecordRejectedSocket") {
                on(ResponseSent) { call ->
                    if (call.request.path() == "/contracts/checked-socket" && call.response.status() != HttpStatusCode.SwitchingProtocols) {
                        rejectedSocketStatus = call.response.status()
                    }
                }
            })
            install(Authentication) {
                bearer("BearerAuth") {
                    authenticate { if (it.token == "token") UserIdPrincipal("bearer") else null }
                }
                basic("BasicAuth") {
                    validate { if (it.name == "user" && it.password == "password") UserIdPrincipal("basic") else null }
                }
                provider("ContractsKey") {
                    authenticate { context ->
                        val key = context.call.request.headers["X-Key"]
                        if (key == "key") context.principal(UserIdPrincipal("key"))
                        else context.challenge("key", if (key == null) AuthenticationFailedCause.NoCredentials else AuthenticationFailedCause.InvalidCredentials) { challenge, call ->
                            call.respond(HttpStatusCode.Unauthorized)
                            challenge.complete()
                        }
                    }
                }
            }
            contractsModule(operationsService = object : OperationsService {
                override suspend fun socket(session: DefaultWebSocketServerSession) {
                    session.send(Frame.Text("ready"))
                    session.send(session.incoming.receive())
                }
                override suspend fun checkedSocket(room: Int, session: DefaultWebSocketServerSession) { session.send(Frame.Text(room.toString())) }
                override suspend fun checked(ratio: Double, mode: String) = mode
                override suspend fun checkedBody(contentType: String, value: String) = value
                override suspend fun encoded(epoch: java.time.Instant, date: java.time.Instant) = EncodedValues(date, epoch, epoch, emptyList(), java.time.Duration.ZERO, epoch)
                override suspend fun delimited(tags: List<String>) = tags
                override suspend fun uploadTuple(body: ContractsOperationsUploadTupleMultipart) = body.item1 + ":" + body.item2.bytes.size
                override suspend fun streamUpload(parts: Flow<StreamInputPart>) = parts.toList().size
                override suspend fun uploadMixed(body: ContractsOperationsUploadMixedMultipart) = body.item1.name + ":" + body.item2.bytes.size
                override suspend fun uploadRepeated(body: ContractsOperationsUploadRepeatedMultipart) = body.item1 + ":" + body.item2.joinToString(",")
                override suspend fun lines() = flowOf(Pet("Milo"), Pet("Luna"))
                override suspend fun linesMetadata(empty: Boolean?) = if (empty == true) LinesMetadataResult.NoContent else LinesMetadataResult.Created(flowOf(Pet("Milo")), "jsonl-trace")
                override suspend fun eventsMetadata() = EventsMetadataResult.Accepted(flowOf(SseMessage("first"), SseMessage("second")), "sse-trace")
                override suspend fun updates() = UpdatesResult.Created(flowOf(PetUpdates.Added(Pet("Milo")), PetUpdates.Finished), "typed-trace")
                override suspend fun mixedStream(jsonl: Boolean) = if (jsonl) MixedStreamResult.Ok(flowOf(Pet("Milo"))) else MixedStreamResult.Ok2(flowOf(SseMessage("mixed")))
                override suspend fun ingest(body: Flow<Pet>) = body.toList().size
                override suspend fun download() = HttpFile("example.bin", "application/octet-stream", byteArrayOf(0, 1, -1))
                override suspend fun bundle() = Bundle("caption", Pet("Milo"), HttpFile("image.bin", "application/octet-stream", byteArrayOf(0, 1, -1)), null)
                override suspend fun bundleError() { throw BundleException(Bundle("missing", Pet("Milo"), HttpFile("error.bin", "application/octet-stream", byteArrayOf(0, 1, -1)))) }
                override suspend fun mixedBundle() = MixedBundleResponseMultipart(Pet("Milo"), HttpFile("image.bin", "application/octet-stream", byteArrayOf(0, 1, -1)))
                override suspend fun probe(filter: Map<String, String>, code: Code) = Probe(filter, code)
                override suspend fun open(body: OpenModel) = body
                override suspend fun tuple(body: Geometry) = body
                override suspend fun envelope(body: WireEnvelope) = body
            }, securedService = object : SecuredService {
                override suspend fun mixed() {}
                override suspend fun optional() {}
            })
        }
        val api = ContractsApiClient(createClient { contractsDefaults() }, "")
        api.operations.socket { session ->
            assertEquals("ready", (session.incoming.receive() as Frame.Text).readText())
            session.send(Frame.Text("echo"))
            assertEquals("echo", (session.incoming.receive() as Frame.Text).readText())
        }
        api.operations.checkedSocket(1) { session -> assertEquals("1", (session.incoming.receive() as Frame.Text).readText()) }
        val invalidSocket = assertFailsWith<IllegalStateException> {
            createClient { contractsDefaults() }.webSocketSession("/contracts/checked-socket?room=0")
        }
        assertEquals("WebSocket connection failed", invalidSocket.message)
        assertEquals(HttpStatusCode.BadRequest, rejectedSocketStatus)
        val upload = HttpFile("image.bin", "application/octet-stream", byteArrayOf(1, 2, 3))
        assertEquals("caption:3", api.operations.uploadTuple(ContractsOperationsUploadTupleMultipart("caption", upload)))
        assertEquals(1, api.operations.streamUpload(StreamInput("present")))
        for (names in listOf(listOf("other"), listOf("label", "label"))) {
            assertEquals(400, client.post("/contracts/stream-upload") {
                setBody(io.ktor.client.request.forms.MultiPartFormDataContent(io.ktor.client.request.forms.formData {
                    names.forEach { append(it, "value") }
                }))
            }.status.value)
        }
        assertEquals("Milo:3", api.operations.uploadMixed(ContractsOperationsUploadMixedMultipart(Pet("Milo"), upload)))
        val rawParts = listOf("caption", "first", "second").joinToString("") {
            "--parts\r\nContent-Disposition: form-data\r\nContent-Type: text/plain\r\n\r\n$it\r\n"
        } + "--parts--\r\n"
        val repeated = client.post("/contracts/repeated-upload") {
            contentType(ContentType.parse("multipart/mixed; boundary=parts")); setBody(rawParts)
        }
        assertEquals(200, repeated.status.value)
        assertEquals("caption:first,second", repeated.bodyAsText())
        assertEquals("strict", api.operations.checked(1.0, "strict"))
        assertEquals("ok", api.operations.checkedBody("application/json", "ok"))
        assertFailsWith<IllegalArgumentException> { api.operations.checkedBody("application/json", "x") }
        assertEquals(400, client.post("/contracts/checked-body") {
            contentType(ContentType.Application.Json)
            setBody("\"x\"")
        }.status.value)
        val instant = java.time.Instant.parse("2025-01-01T00:00:00Z")
        assertEquals(instant, api.operations.encoded(instant, instant).epoch)
        assertEquals(listOf("a", "b"), api.operations.delimited(listOf("a", "b")))
        assertFailsWith<IllegalArgumentException> { api.operations.checked(0.0, "strict") }
        assertEquals(400, client.get("/contracts/checked?ratio=0&mode=strict").status.value)
        assertEquals(400, client.get("/contracts/checked?ratio=1&mode=wrong").status.value)
        assertEquals(listOf(Pet("Milo"), Pet("Luna")), api.operations.lines().toList())
        var expired: Flow<Pet>? = null
        api.operations.linesMetadata { result ->
            val created = kotlin.test.assertIs<LinesMetadataResult.Created>(result)
            assertEquals("jsonl-trace", created.trace)
            assertEquals(listOf(Pet("Milo")), created.body.toList())
            expired = created.body
            assertFailsWith<IllegalStateException> { created.body.toList() }
        }
        assertFailsWith<IllegalStateException> { expired!!.toList() }
        api.operations.linesMetadata(empty = true) { assertEquals(LinesMetadataResult.NoContent, it) }
        api.operations.eventsMetadata { result ->
            val accepted = kotlin.test.assertIs<EventsMetadataResult.Accepted>(result)
            assertEquals("sse-trace", accepted.trace)
            assertEquals(listOf("first", "second"), accepted.body.toList().map { it.data })
        }
        api.operations.updates { result ->
            val created = kotlin.test.assertIs<UpdatesResult.Created>(result)
            assertEquals("typed-trace", created.trace)
            assertEquals(listOf(PetUpdates.Added(Pet("Milo")), PetUpdates.Finished), created.body.toList())
        }
        api.operations.mixedStream(true) { result ->
            assertEquals(listOf(Pet("Milo")), kotlin.test.assertIs<MixedStreamResult.Ok>(result).body.toList())
        }
        api.operations.mixedStream(false) { result ->
            assertEquals(listOf("mixed"), kotlin.test.assertIs<MixedStreamResult.Ok2>(result).body.toList().map { it.data })
        }
        assertEquals(2, api.operations.ingest(flowOf(Pet("Milo"), Pet("Luna"))))
        assertEquals(400, client.post("/contracts/ingest") {
            contentType(ContentType.parse("application/jsonl"))
            setBody("{bad json}\n")
        }.status.value)
        assertEquals(415, client.post("/contracts/ingest") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }.status.value)
        assertEquals(HttpFile("example.bin", "application/octet-stream", byteArrayOf(0, 1, -1)), api.operations.download())
        val bundle = api.operations.bundle()
        val bundleError = assertFailsWith<BundleException> { api.operations.bundleError() }
        assertEquals(404, bundleError.status)
        assertEquals("missing", bundleError.error.caption)
        assertEquals("caption", bundle.caption)
        assertEquals(Pet("Milo"), bundle.pet)
        assertEquals(HttpFile("image.bin", "application/octet-stream", byteArrayOf(0, 1, -1)), bundle.photo)
        assertEquals(null, bundle.extra)
        val mixedBundle = api.operations.mixedBundle()
        assertEquals(Pet("Milo"), mixedBundle.item1)
        assertEquals(bundle.photo, mixedBundle.item2)
        val filter = mapOf("brackets" to "a[b]", "quoted" to "\"value\"")
        assertEquals(Probe(filter, Code.OK), api.operations.probe(filter, Code.OK))
        val open = OpenModel("example", mapOf("extra" to JsonPrimitive(7)))
        assertEquals(open, api.operations.open(open))
        val geometry = Geometry(GeometryPoint(1.0, 2.0), GeometryMetadata("a", 3, false))
        assertEquals(geometry, api.operations.tuple(geometry))
        val envelope: WireEnvelope = WireEnvelope.Message("hello")
        assertEquals(envelope, api.operations.envelope(envelope))
        val cases = listOf(
            Triple("mixed", emptyMap(), 401),
            Triple("mixed", mapOf("Authorization" to "Bearer token"), 401),
            Triple("mixed", mapOf("X-Key" to "key"), 401),
            Triple("mixed", mapOf("Authorization" to "Bearer token", "X-Key" to "key"), 204),
            Triple("mixed", mapOf("Authorization" to "Basic dXNlcjpwYXNzd29yZA=="), 204),
            Triple("optional", emptyMap(), 204),
            Triple("optional", mapOf("Authorization" to "Bearer token"), 401),
            Triple("optional", mapOf("Authorization" to "Bearer bad"), 401),
            Triple("optional", mapOf("Authorization" to "Bearer token", "X-Key" to "key"), 204),
        )
        for ((route, headers, status) in cases) {
            val response = client.get("/contracts/auth/$route") { headers.forEach { (name, value) -> header(name, value) } }
            assertEquals(status, response.status.value, "$route with $headers")
        }
    }
}
