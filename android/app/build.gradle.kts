import java.net.URI
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val localInstance = Properties().apply {
    rootProject.file("itransfer.local").takeIf { it.isFile }?.inputStream()?.use(::load)
}
val productionOrigin = providers.gradleProperty("itransfer.serverOrigin")
    .orElse(localInstance.getProperty("serverOrigin", "https://itransfer.example.test")).get()
require(Regex("https://[a-zA-Z0-9.-]+(?::[0-9]+)?").matches(productionOrigin)) {
    "itransfer.serverOrigin must be an HTTPS origin."
}
val publicLinkAliases = providers.gradleProperty("itransfer.publicLinkAliases")
    .orElse(localInstance.getProperty("publicLinkAliases", "")).get()
require(publicLinkAliases.isEmpty() || publicLinkAliases.split(',').all { Regex("[a-zA-Z0-9.-]+").matches(it) }) {
    "itransfer.publicLinkAliases must be a comma-separated list of hostnames."
}
val debugOrigin = providers.gradleProperty("itransfer.debugOrigin").orElse(productionOrigin).get()
require(Regex("(?:https://[a-zA-Z0-9.-]+|http://(?:127\\.0\\.0\\.1|10\\.0\\.2\\.2|localhost))(?::[0-9]+)?").matches(debugOrigin)) {
    "itransfer.debugOrigin must be an HTTPS origin or an HTTP Android test host."
}

val signingDir = rootProject.file(providers.environmentVariable("ITRANSFER_SIGNING_DIR").orElse(".signing").get())
val signingFile = signingDir.resolve("signing.properties")
val releaseKeys = if (signingFile.isFile) {
    Properties().apply { signingFile.inputStream().use(::load) }
} else null

android {
    namespace = "com.vivacityholding.itransfer"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.vivacityholding.itransfer"
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "0.3.0"
        manifestPlaceholders["itransferHost"] = URI(productionOrigin).host
        buildConfigField("String", "SERVER_ORIGIN", "\"$productionOrigin\"")
        buildConfigField("String", "PUBLIC_LINK_ALIASES", "\"$publicLinkAliases\"")
    }

    val privateSigning = releaseKeys?.let { keys ->
        signingConfigs.create("privateRelease") {
            storeFile = signingDir.resolve(keys.getProperty("storeFile"))
            storePassword = keys.getProperty("storePassword")
            keyAlias = keys.getProperty("keyAlias")
            keyPassword = keys.getProperty("keyPassword")
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            buildConfigField("String", "SERVER_ORIGIN", "\"$debugOrigin\"")
            if (debugOrigin != productionOrigin) buildConfigField("String", "PUBLIC_LINK_ALIASES", "\"\"")
        }
        release {
            signingConfig = privateSigning
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    sourceSets.getByName("main").assets.srcDir(rootProject.file("../frontend/src/i18n/locales"))
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
}

kotlin.compilerOptions.jvmTarget = JvmTarget.JVM_17

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.05.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.material3:material3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
}
