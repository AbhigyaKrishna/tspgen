plugins {
    kotlin("jvm") version "2.4.20"
    kotlin("plugin.serialization") version "2.4.20"
    `java-test-fixtures`
}

repositories {
    mavenCentral()
}

val ktor = "3.6.0"
val ktorModules = listOf(
    "ktor-server-core",
    "ktor-server-content-negotiation",
    "ktor-server-status-pages",
    "ktor-server-auth",
    "ktor-server-resources",
    "ktor-server-sse",
    "ktor-server-websockets",
    "ktor-serialization-kotlinx-json",
    "ktor-client-core",
    "ktor-client-websockets",
    "ktor-client-content-negotiation",
)

dependencies {
    ktorModules.forEach {
        implementation("io.ktor:$it:$ktor")
        testFixturesImplementation("io.ktor:$it:$ktor")
    }
    implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.8.0")
    testFixturesImplementation("org.jetbrains.kotlinx:kotlinx-datetime:0.8.0")
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        optIn.add("kotlin.time.ExperimentalTime")
    }
    sourceSets.main {
        kotlin.srcDirs("generated", "client/generated", "server/generated")
    }
}

subprojects {
    apply(plugin = "org.jetbrains.kotlin.jvm")
    apply(plugin = "org.jetbrains.kotlin.plugin.serialization")

    repositories {
        mavenCentral()
    }

    dependencies {
        "testImplementation"(project(":"))
        "testImplementation"(testFixtures(project(":")))
        ktorModules.forEach { "testImplementation"("io.ktor:$it:$ktor") }
        "testImplementation"("org.jetbrains.kotlinx:kotlinx-datetime:0.8.0")
        "testImplementation"("io.ktor:ktor-server-test-host:$ktor")
        "testImplementation"("io.ktor:ktor-server-cio:$ktor")
        "testImplementation"("io.ktor:ktor-client-cio:$ktor")
        "testImplementation"(kotlin("test"))
    }

    extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension> {
        jvmToolchain(17)
        compilerOptions {
            optIn.add("kotlin.time.ExperimentalTime")
        }
    }

    tasks.named<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>("compileTestKotlin") {
        // The runtime tests also exercise internal generated transport helpers.
        friendPaths.from(rootProject.tasks.named<Jar>("jar").flatMap { it.archiveFile })
    }
    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
    }
}
