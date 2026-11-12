# Pure XML transformation: no Task Scheduler calls or filesystem operations.
function Remove-ChatbotTaskRetryPolicy {
    param([Parameter(Mandatory)][string]$Xml)
    $doc=New-Object Xml.XmlDocument
    $doc.XmlResolver=$null
    $doc.LoadXml($Xml)
    if ($doc.DocumentType) { throw 'Task XML document types are not permitted.' }
    $ns=New-Object Xml.XmlNamespaceManager($doc.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    if ($null -eq $doc.SelectSingleNode('/t:Task/t:Settings',$ns)) { throw 'Task settings absent.' }
    $nodes=@($doc.SelectNodes('/t:Task/t:Settings/t:RestartOnFailure',$ns))
    if($nodes.Count -gt 1){throw 'Ambiguous retry policy.'}
    foreach($node in $nodes){[void]$node.ParentNode.RemoveChild($node)}
    return $doc.OuterXml
}
