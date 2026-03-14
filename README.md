# Proxy Master 3000

An automatic http-proxy switcher, based on a per-proxy performance score. Specify a list of proxies and it will cycle between them

Example:
```sh
cat proxies.txt
    >> http://proxy1.com
    >> http://proxy2.com
    >> http://proxy3.com
```

It will cycle between theses proxies, each proxy will hold a success score. When the success score goes down we stop using that proxy.
