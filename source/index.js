
// Note : fonction Lambda ayant un Stream Kinesis comme trigger

var AWS = require("aws-sdk");
const AWSXRay = require('aws-xray-sdk');
//var AWS = AWSXRay.captureAWS(require('aws-sdk'));

AWS.config.update({region: 'eu-west-1'});

exports.handler = (event, context, callback) => {

	// Récuperation du 'trace_id' et du 'parent_id' de x-ray pour activer la trace le plus tôt possible
	// La trace_ID de X-ray n'étant pas transmise nativement par Kinesis pour le moment, elle a été placée manuellement dans le Record. Il faut la récupérer :
	var record = event.Records[event.Records.length - 1];
console.log("record : " + record);

	const prePayload = new Buffer(record.kinesis.data, 'base64').toString('utf8');
console.log("prePayload : " + prePayload);
	const preParsed = JSON.parse(prePayload);
	const xray_trace_id = preParsed.xray_trace_id; //"1-581cf771-a006649127e371903a2de979";
	const xray_parent_id = preParsed.xray_id; //"70de5b6f19ff9a0b";
console.log("xray_trace_id : " + xray_trace_id);
console.log("Parent id : " + xray_parent_id);
	// Le 'parent_id' est le 'subsegment_id' créé automatiquement par X-ray pour Kinesis dans la fonction Lambda en amont ayant transmis le message à Kinesis
	// Le 'parent_id' sert à afficher le lien visuel (edge) entre Kinesis et le segment créé ci-dessous manuellement dans le service map de X-ray

	
    //  Création manuelle d'un segment X-ray pour pouvoir associer la trace_id et SQS à cette fonction, car impossible à associer avec le segment céé automatiquement pas X-ray à l'activation de la fonction Lambda :
	var segment = new AWSXRay.Segment('steamCheckPriceKinesis-Workstation', xray_trace_id, xray_parent_id);
	AWSXRay.setSegment(segment);
	  
    const arnTopic = process.env.SNS_TOPIC_ARN; //"arn:aws:sns:eu-west-1:962109799108:SteamEvolutionPrix";  // Topic SNS utilisé pour l'envoie de SMS
    const URLsteam = process.env.STEAM_URL //'https://store.steampowered.com/api/appdetails?appids=';  // URL de steam contenant le détail des informatiosn de l'application
    var IDproduit = '';
		
    // Traitement de chaque message reçu pas Kinesis (Il y en a souvent plusieurs par stream) :
    event.Records.forEach(function(record) {
        // Kinesis data is base64 encoded so decode here
        var payload = new Buffer(record.kinesis.data, 'base64').toString('utf8');
        // Get our unified log event.
        console.log("payload : " + payload);
        var parsed = JSON.parse(payload);
        var IDproduit = parsed.ID_PRODUIT;
        console.log("IDproduit from payload : " + IDproduit);
    
        // Creation de l'URL a requeter pour obtenir les infos sur le produit :
        var URLproduit = URLsteam + IDproduit;

		// Création d'un subsegment X-Ray permettant de suivre l'execution d'une partie du code et remonter des annotations dans les traces X-Ray :
		AWSXRay.captureFunc('appelSteam - ' + IDproduit, function(subsegment){
			subsegment.addAnnotation('traceGlobale', `Evolution_Prix_Depuis_Lambda`);
			subsegment.addMetadata('metaGlobale', `Evolution_Prix_Depuis_Lambda`);
			subsegment.addAnnotation('URLproduit', URLproduit);
			subsegment.addAnnotation('produit', IDproduit);		
			
			//requestProductPrice(URLproduit, function(responseFromFunction){
			
			// Initialisation de 'https' avec X-Ray afin de remonter la trace de l'appel vers l'API Steam :
			const https = AWSXRay.captureHTTPs(require('https'));
			//const https = require('https');
			https.get(URLproduit, (resp) => {
		
			let data = '';
			
			// A chunk of data has been recieved.
			resp.on('data', (chunk) => {
				data += chunk;
			});
		
			// The whole response has been received. Print out the result.
			resp.on('end', () => {
				//console.log('STATUS: ' + resp.statusCode);
				var receivedData = JSON.parse(data);
	//            callback (receivedData);

				var profile = receivedData;
	//            var profile = responseFromFunction;
				//console.log('Nom du produit : ' + profile[IDproduit].data.name);
				
				if ( profile[IDproduit].data.price_overview.initial != profile[IDproduit].data.price_overview.final ) {
					var eventText = 'Article : ' + profile[IDproduit].data.name + "\r\n" +
									'Prix de référence : ' + profile[IDproduit].data.price_overview.initial + "\r\n" +
									'Nouveau prix : ' + profile[IDproduit].data.price_overview.final + "\r\n" +
									'Taux de réduction : ' + profile[IDproduit].data.price_overview.discount_percent + "%";
								
					console.log("Received event:", eventText);
					
					// Utilisation de X-Ray pour tracer l'appel vers SNS :
					const sns = AWSXRay.captureAWSClient(new AWS.SNS());
					//var sns = new AWS.SNS();
					var params = {
						Message: eventText, 
						Subject: "Evolution du prix",
						TopicArn: arnTopic
					};
	//				sns.publish(params, context.done);
					console.log('Le prix de ' + profile[IDproduit].data.name + ' a ete revu a la baisse');
					subsegment.addAnnotation('evolutionPrix', 'baisse');
				}
				else {
					console.log('Le prix de ' + profile[IDproduit].data.name + ' reste inchange');
					subsegment.addAnnotation('evolutionPrix', 'RAS');
				}

				}).on("error", (err) => {
					console.log("Error: " + err.message);
				});
				// Le traitement de cette application est terminé : fermeture du subsegment X-ray, sinon les informations le concernant ne sont pas envoyées à X-ray
				subsegment.close();
			});
		}); // Subsegment X-ray
    }); //foreach
	segment.close();
    console.log("Processed " + event.Records.length + " records.");
    callback(null, 'Fonction terminee');
};


// Au final c'est fonction n'est jamais appelée ...
function requestProductPrice(URLproduit, callback) {
	
//	AWSXRay.captureFunc('annotations', function(subsegment){
//		subsegment.addAnnotation('traceGlobale', `Evolution_Prix_Depuis_Lambda`);
//       subsegment.addMetadata('metaGlobale', `Evolution_Prix_Depuis_Lambda`);
//		subsegment.addAnnotation('URLproduit', URLproduit);
    
		//Utilisation de X-Ray :
//		const https = AWSXRay.captureHTTPs(require('https'));
		
		const https = require('https');
		https.get(URLproduit, (resp) => {
		
			let data = '';
			
			// A chunk of data has been recieved.
			resp.on('data', (chunk) => {
				data += chunk;
			});
		
			// The whole response has been received. Print out the result.
			resp.on('end', () => {
				//console.log('STATUS: ' + resp.statusCode);
				var receivedData = JSON.parse(data);
//				subsegment.close();
				callback (receivedData);
			});
		
		}).on("error", (err) => {
			console.log("Error: " + err.message);
		});
//	});
}