plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.reeflight.k7"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.reeflight.k7"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    // One fixed key so every build (local or CI) can update the installed app
    // in place. It only signs this personal sideloaded app; it is not a store key.
    signingConfigs {
        create("sideload") {
            storeFile = file("reeflight-sideload.keystore")
            storePassword = "reeflight"
            keyAlias = "reeflight"
            keyPassword = "reeflight"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("sideload")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.github.EspressifApp:lib-esptouch-android:1.1.1")
    testImplementation("junit:junit:4.13.2")
}
