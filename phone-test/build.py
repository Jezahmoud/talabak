import json,zlib,base64,sys
host=sys.argv[1] if len(sys.argv)>1 else 'https://ntfy.sh'
itty=sys.argv[2] if len(sys.argv)>2 else 'https://itty.bitty.site/#/'
tpl=open('customer.tpl.html').read()
c=open('cashier.src.html').read().replace('__TPL__',json.dumps(tpl,ensure_ascii=False).replace('</','<\\/')).replace("const HOST='https://ntfy.sh'","const HOST='%s'"%host).replace("'https://itty.bitty.site/#/'","'%s'"%itty)
url=itty+base64.b64encode(zlib.compress(c.encode(),9)).decode()
print(url)
