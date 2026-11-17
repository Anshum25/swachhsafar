package com.acpl

import android.os.Parcel
import android.os.Parcelable

/**
 * Data model returned by the ACPL Scanner Support tools app (`com.acpl.fingerscannersupport`)
 * via Intent extras ("ACPL_L1_Data").
 *
 * Serialization order matches the ACPL L1 service parcel specification.
 */
class ACPL_L1_Data : Parcelable {

    var serialNumber: String? = null
    var templateBase64: String? = null
    var bmpBase64: String? = null
    var isoImgBase64: String? = null
    var base64BMPIMage: String? = null
    var base64ISOTemplate: String? = null
    var base64RAWIMage: String? = null
    var nfiq: Int = 0
    var imageWidth: Int = 0
    var imageHeight: Int = 0
    var imageDPI: Int = 0
    var status: String? = null
    var errorCode: Int = 0
    var isMatchSuccess: Boolean = false
    var matchScore: Int = 0
    var matchIDseqNo: String? = null
    var dc: String? = null
    var mi: String? = null

    constructor()

    constructor(parcel: Parcel) {
        serialNumber = parcel.readString()
        templateBase64 = parcel.readString()
        bmpBase64 = parcel.readString()
        isoImgBase64 = parcel.readString()
        base64BMPIMage = parcel.readString()
        base64ISOTemplate = parcel.readString()
        base64RAWIMage = parcel.readString()
        nfiq = parcel.readInt()
        imageWidth = parcel.readInt()
        imageHeight = parcel.readInt()
        imageDPI = parcel.readInt()
        status = parcel.readString()
        errorCode = parcel.readInt()
        isMatchSuccess = parcel.readByte() != 0.toByte()
        matchScore = parcel.readInt()
        matchIDseqNo = parcel.readString()
        dc = parcel.readString()
        mi = parcel.readString()
    }

    override fun writeToParcel(parcel: Parcel, flags: Int) {
        parcel.writeString(serialNumber)
        parcel.writeString(templateBase64)
        parcel.writeString(bmpBase64)
        parcel.writeString(isoImgBase64)
        parcel.writeString(base64BMPIMage)
        parcel.writeString(base64ISOTemplate)
        parcel.writeString(base64RAWIMage)
        parcel.writeInt(nfiq)
        parcel.writeInt(imageWidth)
        parcel.writeInt(imageHeight)
        parcel.writeInt(imageDPI)
        parcel.writeString(status)
        parcel.writeInt(errorCode)
        parcel.writeByte(if (isMatchSuccess) 1 else 0)
        parcel.writeInt(matchScore)
        parcel.writeString(matchIDseqNo)
        parcel.writeString(dc)
        parcel.writeString(mi)
    }

    override fun describeContents(): Int = 0

    companion object CREATOR : Parcelable.Creator<ACPL_L1_Data> {
        override fun createFromParcel(parcel: Parcel): ACPL_L1_Data {
            return ACPL_L1_Data(parcel)
        }

        override fun newArray(size: Int): Array<ACPL_L1_Data?> {
            return arrayOfNulls(size)
        }
    }
}

