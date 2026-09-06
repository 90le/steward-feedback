// Trusted, temporary viewer. It never starts or serves code from the generated backend.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const sha=text=>createHash('sha256').update(text).digest('hex');
const read=(name,limit)=>{const file=path.join(root,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw new Error('PREVIEW_FILE_INVALID');return fs.readFileSync(file,'utf8');};
const args=process.argv.slice(2);let backend=null,port=0;
for(let i=0;i<args.length;i++){
  if(args[i]==='--backend')backend=new URL(args[++i]);
  else if(args[i]==='--port')port=Number(args[++i]);
  else throw new Error('PREVIEW_ARGUMENT_INVALID');
}
if(!Number.isInteger(port)||port<0||port>65535)throw new Error('PREVIEW_PORT_INVALID');
if(backend&&(backend.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(backend.hostname)||backend.username||backend.password||backend.pathname!=='/'||backend.search||backend.hash))throw new Error('PREVIEW_BACKEND_MUST_BE_LOOPBACK');
const manifest=JSON.parse(read('preview-manifest.json',32768)),original=read('index.html',524288);
if(manifest.packagingVersion!=='contained-v1'||sha(original)!==manifest.previewSha256)throw new Error('PREVIEW_HASH_MISMATCH');
let html=original;
if(backend){
  if(!manifest.backend)throw new Error('PREVIEW_BACKEND_NOT_DECLARED');
  html=html.replace('data-steward-preview-mode="static"','data-steward-preview-mode="backend"').replace("connect-src 'none'","connect-src 'self'");
  if(sha(html)!==manifest.backendPreviewSha256)throw new Error('PREVIEW_BACKEND_HASH_MISMATCH');
}
const allowedHeaders=['content-type','x-user-id','x-acting-user'];let inFlight=0,started=Date.now(),requests=0;
const respond=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
const collect=async(stream,limit)=>{const parts=[];let size=0;for await(const part of stream){size+=part.length;if(size>limit)throw new Error('PREVIEW_PAYLOAD_LIMIT');parts.push(part);}return Buffer.concat(parts);};
const server=http.createServer(async(req,res)=>{
  const address=server.address(),expected='http://127.0.0.1:'+address.port;
  if(req.headers.host!=='127.0.0.1:'+address.port&&req.headers.host!=='localhost:'+address.port)return respond(res,403,{error:'PREVIEW_HOST_DENIED'});
  if(req.headers.origin&&req.headers.origin!==expected)return respond(res,403,{error:'PREVIEW_ORIGIN_DENIED'});
  if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))return respond(res,403,{error:'PREVIEW_ORIGIN_DENIED'});
  if(req.method==='GET'&&(req.url==='/'||req.url==='/index.html')){
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(html);return;
  }
  if(!backend||typeof req.url!=='string'||req.url.length>512||!/^\/api\/[A-Za-z0-9_/-]+$/.test(req.url)||!['GET','POST','PUT','PATCH','DELETE'].includes(req.method))return respond(res,404,{error:'PREVIEW_PATH_DENIED'});
  const url=new URL(req.url,backend);
  if(url.origin!==backend.origin||!url.pathname.startsWith('/api/')||url.search||url.hash)return respond(res,403,{error:'PREVIEW_PATH_DENIED'});
  if(inFlight>=4)return respond(res,429,{error:'PREVIEW_BUSY'});
  if(Date.now()-started>=60000){started=Date.now();requests=0;}if(++requests>120)return respond(res,429,{error:'PREVIEW_RATE_LIMIT'});
  if(req.headers.authorization||req.headers.cookie)return respond(res,403,{error:'PREVIEW_CREDENTIALS_DENIED'});
  const headers={};
  for(const name of allowedHeaders){
    const value=req.headers[name];if(value===undefined)continue;
    if(typeof value!=='string'||value.length>64||(name==='content-type'?value.toLowerCase()!=='application/json':!/^[A-Za-z0-9_-]{1,64}$/.test(value)))return respond(res,400,{error:'PREVIEW_HEADER_DENIED'});
    headers[name]=value;
  }
  inFlight++;
  try{
    const body=await collect(req,32768);
    if(req.method==='GET'&&body.length)return respond(res,400,{error:'PREVIEW_BODY_DENIED'});
    const response=await fetch(url,{method:req.method,headers,body:req.method==='GET'?undefined:body,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!(response.headers.get('content-type')??'').toLowerCase().includes('application/json'))throw new Error('PREVIEW_RESPONSE_DENIED');
    const data=await collect(response.body??[],262144);JSON.parse(data.toString('utf8'));
    res.writeHead(response.status,{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);
  }catch{if(!res.headersSent)respond(res,502,{error:'PREVIEW_BACKEND_UNAVAILABLE'});else res.destroy();}
  finally{inFlight--;}
});
server.listen(port,'127.0.0.1',()=>console.log('STEWARD_PREVIEW_URL=http://127.0.0.1:'+server.address().port));
server.requestTimeout=15000;server.headersTimeout=10000;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
