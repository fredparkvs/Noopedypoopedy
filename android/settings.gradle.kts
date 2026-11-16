pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Espressif's EspTouch (WiFi provisioning) library is published on JitPack
        maven("https://jitpack.io") {
            content { includeGroup("com.github.EspressifApp") }
        }
    }
}

rootProject.name = "ReefLight"
include(":app")
