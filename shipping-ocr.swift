import Foundation
import Vision
import ImageIO
import CoreImage
let products = CommandLine.arguments.contains("--products")
let urls = CommandLine.arguments.dropFirst().filter { $0 != "--products" }.map { URL(fileURLWithPath:$0) }
do {
 var lines:[String]=[], codes:[String]=[], rows:[[String:Any]]=[], logoEvidence:[[String:Any]]=[], pages:[[String:Any]]=[]
 for (page,url) in urls.enumerated() {
  let lineStart=lines.count, codeStart=codes.count, evidenceStart=logoEvidence.count
  let text = VNRecognizeTextRequest()
  text.recognitionLevel = .accurate
  text.recognitionLanguages = ["zh-Hans", "en-US"]
  text.usesLanguageCorrection = false
  text.minimumTextHeight = 0.005
  text.customWords = ["韵达快运", "韵达", "顺丰", "德邦", "中通", "极兔", "安能", "德坤浩运", "豪翔运输", "鸿泰物流", "创新物流"]
  let barcode = VNDetectBarcodesRequest()
  guard let input=CIImage(contentsOf:url,options:[.applyOrientationProperty:true]) else { throw NSError(domain:"ocr",code:1) }
  let factor=max(1.0,min(5.0,1800.0/input.extent.width))
  let scaled=input.transformed(by:CGAffineTransform(scaleX:factor,y:factor))
  guard let image=CIContext().createCGImage(scaled,from:scaled.extent) else { throw NSError(domain:"ocr",code:2) }
  try VNImageRequestHandler(cgImage:image,options:[:]).perform([text,barcode])
  let observations=(text.results ?? []).sorted { a,b in abs(a.boundingBox.midY-b.boundingBox.midY)>0.015 ? a.boundingBox.midY>b.boundingBox.midY : a.boundingBox.minX<b.boundingBox.minX }
  lines += observations.compactMap { $0.topCandidates(1).first?.string }
  codes += (barcode.results ?? []).compactMap { $0.payloadStringValue }
  if products {
   var groups:[[VNRecognizedTextObservation]]=[]
   for obs in observations {
    if let index=groups.firstIndex(where: { group in abs(group[0].boundingBox.midY-obs.boundingBox.midY) < max(group[0].boundingBox.height,obs.boundingBox.height)*0.5 }) { groups[index].append(obs) } else { groups.append([obs]) }
   }
   for group in groups.sorted(by: { $0[0].boundingBox.midY > $1[0].boundingBox.midY }) {
    let cells:[[String:Any]]=group.sorted(by: {$0.boundingBox.minX < $1.boundingBox.minX}).compactMap { obs in
     guard let result=obs.topCandidates(1).first else { return nil }
     return ["text":result.string,"x":obs.boundingBox.minX,"width":obs.boundingBox.width,"confidence":result.confidence]
    }
    rows.append(["page":page,"cells":cells])
   }
  }
  if !products {
  // Isolate the small carrier logo at the upper right so it is not lost beside the large number.
  let rect=CGRect(x:input.extent.minX+input.extent.width*0.56,y:input.extent.minY+input.extent.height*0.84,width:input.extent.width*0.44,height:input.extent.height*0.16)
  let logo=input.cropped(to:rect).transformed(by:CGAffineTransform(scaleX:8,y:8))
  if let logoImage=CIContext().createCGImage(logo,from:logo.extent){
   let logoText=VNRecognizeTextRequest();logoText.recognitionLevel = .accurate;logoText.recognitionLanguages=["zh-Hans","en-US"];logoText.minimumTextHeight=0.005;logoText.usesLanguageCorrection=true;logoText.customWords=["韵达快运","韵达","顺丰","中通","圆通","德邦","安能"]
   try VNImageRequestHandler(cgImage:logoImage,options:[:]).perform([logoText])
   lines += (logoText.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  }
  // Retry narrow header bands: decorative logos can fail as a full text block.
  let pageText=observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator:" ")
  let known="顺丰|SF.?EXPRESS|京东|中通|ZTO|圆通|申通|韵达|YUNDA|极兔|德邦|EMS|百世|安能|豪翔|鸿泰物流|创新物流|德坤|DEKUN"
  if pageText.range(of:known,options:[.regularExpression,.caseInsensitive]) == nil {
   var evidence:[String]=[]
   let headerBounds=CGRect(x:input.extent.width*0.1,y:input.extent.height*0.65,width:input.extent.width*0.85,height:input.extent.height*0.30)
   for scale in [1.5,2.5] {
    let crop=input.cropped(to:headerBounds).transformed(by:CGAffineTransform(scaleX:scale,y:scale))
    for gray in [false,true] {
     let prepared=gray ? crop.applyingFilter("CIColorControls",parameters:[kCIInputSaturationKey:0.0,kCIInputContrastKey:1.4]) : crop
     if let cg=CIContext().createCGImage(prepared,from:prepared.extent) {
      let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.recognitionLanguages=["zh-Hans","en-US"];request.usesLanguageCorrection=true;request.minimumTextHeight=0.005;request.customWords=["德坤浩运","德坤","DEKUN LOGISTICS","豪翔运输","鸿泰物流","创新物流"]
      try VNImageRequestHandler(cgImage:cg,options:[:]).perform([request])
      evidence += (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
     }
    }
   }
   let bands:[(Double,Double,Double,Double)]=[(0.55,0.93,0.40,0.04),(0.65,0.93,0.20,0.04),(0.60,0.925,0.30,0.055),(0.65,0.90,0.20,0.03)]
   for band in bands {
    let bounds=CGRect(x:input.extent.minX+input.extent.width*band.0,y:input.extent.minY+input.extent.height*band.1,width:input.extent.width*band.2,height:input.extent.height*band.3)
    for scale in [2.0,4.0] {
     let cropped=input.cropped(to:bounds).transformed(by:CGAffineTransform(scaleX:scale,y:scale))
     for gray in [false,true] {
      let prepared=gray ? cropped.applyingFilter("CIColorControls",parameters:[kCIInputSaturationKey:0.0,kCIInputContrastKey:1.5]) : cropped
      guard let headerImage=CIContext().createCGImage(prepared,from:prepared.extent) else {continue}
      let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.recognitionLanguages=["zh-Hans"];request.usesLanguageCorrection=true;request.minimumTextHeight=0.001;request.customWords=["韵达","韵达快运","中通快运","快运"]
      try VNImageRequestHandler(cgImage:headerImage,options:[:]).perform([request])
      evidence += (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
     }
    }
   }
   logoEvidence.append(["page":page,"texts":Array(Set(evidence)).sorted()])
  }
  }
  pages.append(["lines":Array(lines[lineStart...]),"barcodes":Array(codes[codeStart...]),"logoEvidence":Array(logoEvidence[evidenceStart...])])
 }
 let data=try JSONSerialization.data(withJSONObject:["lines":lines,"barcodes":codes,"rows":rows,"logoEvidence":logoEvidence,"pages":pages])
 FileHandle.standardOutput.write(data)
} catch {
 FileHandle.standardError.write(Data("图片文字识别失败".utf8));exit(1)
}
